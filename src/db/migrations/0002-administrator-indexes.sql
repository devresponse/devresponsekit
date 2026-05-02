-- 0002-administrator-indexes.sql
--
-- Read-optimization migration for the Administrator workspace
-- application (docs/admin-manager.md §3 + §15). Adds:
--   * pg_trgm extension for trigram-indexed name/email search
--   * btree indexes on hot list-view sort/filter columns
--   * GIN trigram indexes on app_users.primary_email and display_name
--   * Soft-delete columns on app_users (per plan §4.1)
--
-- Idempotent: every statement uses `if not exists` / `add column if not exists`.

create extension if not exists "pg_trgm";

-- Soft-delete bookkeeping columns (plan §4.1). The status enum already
-- supports `'deactivated'`; these columns capture who/when/why.
alter table app_users
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by text,
  add column if not exists deactivated_reason text;

-- Hot-path btree indexes on app_users.
create index if not exists idx_app_users_created_at_desc
  on app_users (created_at desc);

-- Audit-explorer indexes.
create index if not exists idx_app_audit_events_created_at_desc
  on app_audit_events (created_at desc);

create index if not exists idx_app_audit_events_actor_created_at
  on app_audit_events (actor_better_auth_user_id, created_at desc);

-- Membership / role lookup paths used by the user-detail tabs.
create index if not exists idx_app_memberships_app_user_id
  on app_organization_memberships (app_user_id);

create index if not exists idx_app_memberships_org_status
  on app_organization_memberships (organization_id, status);

create index if not exists idx_app_user_roles_app_user_id
  on app_user_roles (app_user_id);

create index if not exists idx_app_user_roles_role_id
  on app_user_roles (role_id);

-- Trigram GIN indexes power the global-search box (case-insensitive
-- substring match against email / name) without sequential scans.
create index if not exists idx_app_users_primary_email_trgm
  on app_users using gin (primary_email gin_trgm_ops);

create index if not exists idx_app_users_display_name_trgm
  on app_users using gin (display_name gin_trgm_ops);
