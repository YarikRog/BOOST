-- 0005_lifehack_views.sql
-- Unique views per lifehack, so "did anyone actually read this?" is answerable.
-- Purely additive: creates one table and its indexes, touches no existing data.
--
-- One row per (lifehack, viewer). Repeat opens by the same person do not add
-- rows — the unique index is what enforces "count people, not opens", rather
-- than application logic that could drift.

create table if not exists lifehack_views (
  id           uuid primary key default gen_random_uuid(),
  lifehack_id  uuid not null references lifehacks(id),
  user_id      uuid not null references users(id),
  viewed_at    timestamptz not null default now()
);

-- The dedup guarantee. Also the index used to check "has this user viewed it".
create unique index if not exists uniq_lifehack_view
  on lifehack_views (lifehack_id, user_id);

-- Feed builds counts for a batch of lifehacks on every cache miss.
create index if not exists idx_lifehack_views_lifehack
  on lifehack_views (lifehack_id);
