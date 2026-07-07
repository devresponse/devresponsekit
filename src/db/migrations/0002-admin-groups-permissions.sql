-- 0002-admin-groups-permissions.sql
--
-- Backfills the five `admin.groups.*` permission keys (group governance,
-- ADR-0002) into the baseline permission catalog. `0001-initial-schema.sql`
-- predates them and is FROZEN, so a migrated-but-not-seeded database was
-- missing the group-admin rows that `ADMIN_PERMISSION_CATALOG` in
-- `src/lib/admin/permissions.ts` defines. Keys and descriptions MUST match
-- the catalog verbatim — `tests/unit/migration-permission-catalog-sync.test.ts`
-- diffs the union of every core migration's seeded rows against the catalog.
--
-- Fully idempotent: `on conflict do nothing`, so a database already seeded
-- via `pnpm db:seed` (which sources the catalog directly) is unaffected.

insert into app_permissions (key, description) values
  ('admin.groups.read', 'Read organization groups and their roles/members'),
  ('admin.groups.create', 'Create organization groups'),
  ('admin.groups.update', 'Edit organization groups'),
  ('admin.groups.delete', 'Delete organization groups'),
  ('admin.groups.assign', 'Manage a group''s roles and members')
on conflict (key) do nothing;
