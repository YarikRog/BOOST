-- 0001_init.sql
-- Comfy Knowledge Platform — initial schema.
-- Mirrors TECH_ARCHITECTURE.md §2. Behavior rules: PRODUCT_LOGIC.md.

-- ─────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ─────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────
create type user_role       as enum ('MEGA_ADMIN', 'REGIONAL_IT_LEAD', 'DIRECTOR', 'DEP_DIRECTOR', 'SELLER');
create type user_status      as enum ('active', 'inactive', 'archived');
create type experience       as enum ('lt_6m', '6m_2y', 'gt_2y');
-- categories are DATA, not an enum (white-label: each client deploy seeds its own
-- verticals — see 0002_seed_categories.sql). The product logic is category-agnostic.
create type lifehack_status  as enum ('draft', 'published', 'archived');
-- NOTE: NEW/GROWING/TOP are NOT here — tier is derived, never stored (TECH_ARCHITECTURE §4).
create type workitem_status  as enum ('in_work', 'success', 'partial', 'fail', 'not_tried', 'expired');
create type reaction_type    as enum ('like', 'dislike');
create type invite_status    as enum ('active', 'used', 'revoked');

-- ─────────────────────────────────────────────────────────────
-- Tables (cross-referencing FKs added at the end to break the
-- stores ↔ users cycle)
-- ─────────────────────────────────────────────────────────────

create table regions (
  id    uuid primary key default gen_random_uuid(),
  name  text not null
);

-- Lifehack verticals. Replaces the old hardcoded enum — configured per deploy.
create table categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,   -- stable key used by API/feed cache
  name        text not null,          -- display label
  sort_order  int not null default 0,
  active      boolean not null default true
);

create table stores (
  id          uuid primary key default gen_random_uuid(),
  region_id   uuid not null,
  name        text not null,
  director_id uuid,                       -- nullable until first director login
  created_at  timestamptz not null default now()
);

create table users (
  id                 uuid primary key default gen_random_uuid(),
  telegram_id        bigint unique not null,
  name               text,
  phone              text,
  role               user_role not null,
  region_id          uuid,                -- null for MEGA_ADMIN
  store_id           uuid,                -- null for MEGA_ADMIN / REGIONAL_IT_LEAD
  status             user_status not null default 'active',
  experience_segment experience,          -- set once at onboarding
  created_at         timestamptz not null default now()
);

create table invites (
  id          uuid primary key default gen_random_uuid(),
  token       text unique not null,
  role        user_role not null,
  region_id   uuid,
  store_id    uuid,
  created_by  uuid not null,
  used_by     uuid,
  status      invite_status not null default 'active',
  expires_at  timestamptz
);

create table lifehacks (
  id               uuid primary key default gen_random_uuid(),
  author_id        uuid not null,
  author_store_id  uuid,                  -- SNAPSHOT at publish time (cross-store like logic)
  category_id      uuid not null,
  product_type     text not null,
  title            text not null,
  content_json     jsonb not null,
  status           lifehack_status not null default 'draft',
  created_at       timestamptz not null default now(),
  published_at     timestamptz
);

create table work_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  lifehack_id   uuid not null,
  status        workitem_status not null default 'in_work',
  started_at    timestamptz not null default now(),
  check_due_at  timestamptz not null,    -- started_at + WORK_CHECK_DAYS
  expires_at    timestamptz not null,    -- started_at + WORK_EXPIRY_DAYS
  check_sent    boolean not null default false,  -- idempotent reminder sweep
  resolved_at   timestamptz
);

create table reactions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  lifehack_id           uuid not null,
  type                  reaction_type not null,
  author_store_id_snap  uuid,            -- SNAPSHOT: lifehack.author_store_id at like time
  user_store_id_snap    uuid,            -- SNAPSHOT: liker's store at like time (null for admin/regional)
  is_cross_store        boolean not null,-- derived & frozen at like time
  created_at            timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Foreign keys
-- ─────────────────────────────────────────────────────────────
alter table stores      add constraint fk_stores_region    foreign key (region_id)   references regions(id);
alter table stores      add constraint fk_stores_director  foreign key (director_id) references users(id);
alter table users       add constraint fk_users_region     foreign key (region_id)   references regions(id);
alter table users       add constraint fk_users_store      foreign key (store_id)    references stores(id);
alter table invites     add constraint fk_invites_region   foreign key (region_id)   references regions(id);
alter table invites     add constraint fk_invites_store    foreign key (store_id)    references stores(id);
alter table invites     add constraint fk_invites_creator  foreign key (created_by)  references users(id);
alter table invites     add constraint fk_invites_used_by  foreign key (used_by)     references users(id);
alter table lifehacks   add constraint fk_lifehacks_author foreign key (author_id)   references users(id);
alter table lifehacks   add constraint fk_lifehacks_store  foreign key (author_store_id) references stores(id);
alter table lifehacks   add constraint fk_lifehacks_category foreign key (category_id) references categories(id);
alter table work_items  add constraint fk_workitems_user   foreign key (user_id)     references users(id);
alter table work_items  add constraint fk_workitems_life   foreign key (lifehack_id) references lifehacks(id);
alter table reactions   add constraint fk_reactions_user   foreign key (user_id)     references users(id);
alter table reactions   add constraint fk_reactions_life   foreign key (lifehack_id) references lifehacks(id);

-- ─────────────────────────────────────────────────────────────
-- Constraints that prevent the silent bugs (TECH_ARCHITECTURE §2)
-- ─────────────────────────────────────────────────────────────

-- At most ONE active work-item per user per lifehack.
create unique index uniq_active_workitem
  on work_items (user_id, lifehack_id)
  where status = 'in_work';

-- One reaction per user per lifehack (flipping like↔dislike updates the row).
create unique index uniq_reaction
  on reactions (user_id, lifehack_id);

-- ─────────────────────────────────────────────────────────────
-- Indexes for the sweep workers and feed queries
-- ─────────────────────────────────────────────────────────────
create index idx_workitems_check  on work_items (check_due_at) where status = 'in_work' and check_sent = false;
create index idx_workitems_expiry on work_items (expires_at)   where status = 'in_work';
create index idx_lifehacks_feed   on lifehacks (category_id, status);
create index idx_workitems_scoring on work_items (lifehack_id, status);
