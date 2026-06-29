-- 0002_seed_categories.sql
-- Per-deploy category seed. THIS is the white-label file: swap these rows for any
-- client's verticals (e.g. 'fridges', 'phones', 'cosmetics', 'insurance'). The rest
-- of the system is category-agnostic.
--
-- Default seed = Comfy.

insert into categories (slug, name, sort_order) values
  ('it_service',    'IT Service',    1),
  ('happy_service', 'Happy Service', 2)
on conflict (slug) do nothing;
