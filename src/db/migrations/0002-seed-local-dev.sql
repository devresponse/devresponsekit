-- 0002-seed-local-dev.sql
-- Local development seed data.
--
-- This file is ONLY applied in local development / CI environments.
-- Never run this against production — it creates well-known credentials
-- that are safe to commit to source control because they are never
-- used in production.
--
-- Execution order:
--   1. 0001-app-core.sql (application tables)
--   2. Better Auth migration (auth tables)
--   3. This file (seed data)

-- Seed organization: default fallback for users without a provider org.
insert into app_organizations (id, slug, name, status, is_default)
values ('00000000-0000-0000-0000-000000000001', 'default', 'Default Organization', 'active', true)
on conflict (slug) do nothing;

-- Seed enterprise applications for SSO testing.
insert into app_enterprise_applications (id, label, description, origin, subdomain, sso_audience, status, sort_order)
values
  ('portal',    'DevResponse Portal',    'Primary enterprise portal',    'http://localhost:3000', 'app',     'devresponse-app:portal',    'available', 1),
  ('analytics', 'DevResponse Analytics', 'Analytics and reporting',      'http://localhost:3001', 'reports', 'devresponse-app:analytics', 'available', 2)
on conflict (id) do nothing;

-- Roles for the default organization.
insert into app_roles (organization_id, key, name, description)
values
  ('00000000-0000-0000-0000-000000000001', 'admin',  'Administrator', 'Full access to all resources'),
  ('00000000-0000-0000-0000-000000000001', 'member', 'Member',        'Standard member access')
on conflict (organization_id, key) do nothing;

-- Core permissions.
insert into app_permissions (key, description)
values
  ('admin.users.view',    'View user list and status'),
  ('admin.users.manage',  'Approve, block, suspend, and reactivate users'),
  ('admin.audit.view',    'View audit event log'),
  ('app.dashboard.view',  'View the main dashboard'),
  ('app.workspace.view',  'Access workspace pages')
on conflict (key) do nothing;
