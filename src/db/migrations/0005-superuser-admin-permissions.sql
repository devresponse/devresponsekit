-- 0005-superuser-admin-permissions.sql
--
-- Closes a gap left by 0004-default-superuser.sql: the canonical
-- `admin.*` permission catalog (docs/admin-manager.md §6.1) was only
-- ever inserted into `app_permissions` by the `pnpm db:seed` script,
-- so the cross-join in 0004 that grants every registered permission
-- to the `superuser` role would silently miss every `admin.*.read`
-- key on a database that had only had migrations applied (or whose
-- seed predates the catalog).
--
-- The visible symptom is that `admin@devresponse.local`, who is
-- assigned the `superuser` role by 0004, can enter the Administrator
-- workspace (because the basic `admin` role still grants
-- `admin.users.manage`, satisfying the layout's any-admin gate) but
-- only sees the ungated "Overview" entry in the workspace sidebar —
-- every other group is permission-gated on `admin.*.read` and is
-- therefore hidden.
--
-- This migration:
--
--   1. Inserts the canonical `admin.*` permission catalog into
--      `app_permissions` so it is present even on instances that have
--      not run (or pre-date) the seed script.
--
--   2. Re-grants every currently registered permission to the
--      `superuser` role on the default organization, so any newly
--      inserted `admin.*` keys are picked up alongside the existing
--      grants.
--
-- Idempotent: every statement uses `on conflict do nothing` so it is
-- safe to re-run on a database where the seed has already populated
-- the catalog or where the grants are already in place.

-- 1. Canonical admin.* permission catalog. Keep this list in sync with
--    `ADMIN_PERMISSION_CATALOG` in `src/lib/admin/permissions.ts` —
--    the runtime check, the seed script, and this migration share the
--    same set of keys by convention.
insert into app_permissions (key, description) values
  ('admin.users.read', 'Read administrator user lists and details'),
  ('admin.users.create', 'Create new users'),
  ('admin.users.update', 'Edit user attributes'),
  ('admin.users.delete', 'Soft-delete and restore users'),
  ('admin.users.manage', 'Approve, block, suspend, reactivate users'),
  ('admin.users.ban', 'Ban or unban users via Better Auth'),
  ('admin.users.setRole', 'Set Better Auth role on a user'),
  ('admin.users.setPassword', 'Set or reset a user''s password'),
  ('admin.users.sessions', 'List or revoke user sessions'),
  ('admin.users.impersonate', 'Impersonate another user'),
  ('admin.roles.read', 'Read application roles and permissions'),
  ('admin.roles.create', 'Create application roles'),
  ('admin.roles.update', 'Edit application roles'),
  ('admin.roles.delete', 'Delete application roles'),
  ('admin.roles.assign', 'Assign or unassign roles to users'),
  ('admin.permissions.manage', 'Manage the permission catalog'),
  ('admin.orgs.read', 'Read organizations and memberships'),
  ('admin.orgs.create', 'Create organizations'),
  ('admin.orgs.update', 'Edit organizations'),
  ('admin.orgs.delete', 'Delete organizations'),
  ('admin.orgs.manage', 'Manage organization members and bindings'),
  ('admin.apps.read', 'Read enterprise application catalog'),
  ('admin.apps.manage', 'Create and edit enterprise applications'),
  ('admin.audit.read', 'Read the audit event log')
on conflict (key) do nothing;

-- 2. Re-grant every currently registered permission to the superuser
--    role on the default org. The `on conflict do nothing` guard means
--    pre-existing grants are preserved and only the newly inserted
--    `admin.*` keys are added.
insert into app_role_permissions (role_id, permission_id)
select r.id, p.id
from app_roles r
join app_organizations o on o.id = r.organization_id
cross join app_permissions p
where o.slug = 'default'
  and r.key = 'superuser'
on conflict do nothing;
