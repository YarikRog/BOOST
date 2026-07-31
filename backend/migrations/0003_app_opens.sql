-- 0003_app_opens.sql
-- Track WebApp opens so admins can see engagement (who opens the app, how often),
-- not just actions. One row per open; aggregates are computed on read.

create table if not exists app_opens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id),
  opened_at  timestamptz not null default now()
);

-- Recent-activity queries: "opens in the last N days", "last seen per user".
create index if not exists idx_app_opens_time on app_opens (opened_at desc);
create index if not exists idx_app_opens_user on app_opens (user_id, opened_at desc);
