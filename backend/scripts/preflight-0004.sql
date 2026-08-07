-- preflight-0004.sql
-- Run this against production BEFORE applying 0004_integrity.sql.
-- Read-only: it inspects, it never writes.
--
--   psql "$DATABASE_URL" -f scripts/preflight-0004.sql
--
-- Migration 0004 aborts if duplicate store names exist. This tells you in
-- advance whether that will happen, and exactly which rows to fix.

\echo '=== 1. Duplicate store names (blocks uniq_stores_name_lower) ==='
select lower(s.name)                as normalised_name,
       count(*)                     as copies,
       string_agg(s.id::text, ', ') as store_ids,
       string_agg(coalesce(u.cnt, 0)::text, ', ') as users_per_store
  from stores s
  left join (select store_id, count(*) as cnt from users group by store_id) u
         on u.store_id = s.id
 group by lower(s.name)
having count(*) > 1
 order by copies desc;

\echo '=== 2. If section 1 is empty, the migration will apply cleanly ==='
\echo '    Otherwise: rename or delete the extra stores first. Prefer keeping'
\echo '    the one with users attached; /stores and /regions can delete empty ones.'

\echo ''
\echo '=== 3. Objects 0004 will create (should all be 0 before, 1 after) ==='
select 'consume_invite function' as object,
       count(*) as exists_now
  from pg_proc where proname = 'consume_invite'
union all
select 'uniq_stores_name_lower index',
       count(*) from pg_indexes where indexname = 'uniq_stores_name_lower'
union all
select 'idx_workitems_resolved index',
       count(*) from pg_indexes where indexname = 'idx_workitems_resolved';

\echo ''
\echo '=== 4. Migration ledger (0004 must NOT be listed yet) ==='
select name, run_at from _migrations order by name;
