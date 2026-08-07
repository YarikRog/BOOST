-- 0004_integrity.sql
-- Data-integrity hardening: atomic invite consumption, store-name uniqueness,
-- and the index the recency factor needs.

-- ─────────────────────────────────────────────────────────────
-- Atomic invite consumption
-- ─────────────────────────────────────────────────────────────
-- The old flow was: SELECT invite → INSERT user → UPDATE invite used. Two
-- concurrent /start calls with the same token could both pass the SELECT and
-- both create a user, with only one claiming the invite. Doing all three in a
-- single function makes the claim the gate: the UPDATE ... WHERE status='active'
-- is atomic, so exactly one caller proceeds to create a user.
create or replace function consume_invite(
  p_token       text,
  p_telegram_id bigint,
  p_name        text
)
returns users
language plpgsql
as $$
declare
  v_invite invites;
  v_user   users;
begin
  -- Idempotent re-entry: an already-onboarded telegram id just gets its row.
  select * into v_user from users where telegram_id = p_telegram_id;
  if found then
    return v_user;
  end if;

  -- Atomic claim. Any concurrent caller finds status <> 'active' and gets 0 rows.
  update invites
     set status = 'used'
   where token = p_token
     and status = 'active'
     and (expires_at is null or expires_at > now())
  returning * into v_invite;

  if not found then
    -- Distinguish "no such token" from "already used/expired" for the caller.
    if exists (select 1 from invites where token = p_token) then
      raise exception 'INVITE_NOT_ACTIVE';
    else
      raise exception 'INVITE_NOT_FOUND';
    end if;
  end if;

  insert into users (telegram_id, name, role, region_id, store_id)
  values (p_telegram_id, p_name, v_invite.role, v_invite.region_id, v_invite.store_id)
  returning * into v_user;

  update invites set used_by = v_user.id where id = v_invite.id;

  return v_user;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Store name uniqueness
-- ─────────────────────────────────────────────────────────────
-- Store creation did a case-insensitive SELECT then INSERT; two concurrent
-- requests could both find nothing and both insert. The constraint makes the
-- database the arbiter instead of the race.
-- Refuse to run if duplicates already exist. Auto-renaming them would silently
-- rewrite a real store's name behind an admin's back, and the store name is
-- what people recognise in /stores and invite links — a wrong one is worse than
-- a failed migration. Resolve conflicts manually, then re-run.
do $$
declare
  v_conflicts text;
begin
  select string_agg(format('%s (%s occurrences)', lower(name), cnt), ', ')
    into v_conflicts
    from (select name, count(*) as cnt from stores group by lower(name), name having count(*) > 1) d;

  if v_conflicts is not null then
    raise exception
      'Duplicate store names block uniq_stores_name_lower: %. Rename or delete them, then re-run.',
      v_conflicts;
  end if;
end $$;

create unique index if not exists uniq_stores_name_lower on stores (lower(name));

-- ─────────────────────────────────────────────────────────────
-- Recency lookups
-- ─────────────────────────────────────────────────────────────
-- The feed reads the most recent scored resolution per lifehack on every cache
-- miss; without this it is a sequential scan over all work items.
create index if not exists idx_workitems_resolved
  on work_items (lifehack_id, resolved_at desc)
  where status in ('success', 'partial', 'fail');
