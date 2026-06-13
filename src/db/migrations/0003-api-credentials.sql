-- ---------------------------------------------------------------------------
-- 0003-api-credentials.sql
--
-- Machine credentials for the RESTful API surface (design
-- docs/design-api-keys-and-tokens.md §4). Adds API keys, OAuth2
-- client-credentials principals, and a short-lived JWT revocation list.
--
-- The consolidated initial schema (0001-initial-schema.sql) is never
-- edited after release; the migration runner is multi-file capable, so
-- this ships as an appended NNNN file (docs/setup-better-auth.md §3.1).
--
-- Fully idempotent: `create … if not exists` + `on conflict do nothing`.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- Machine API keys. Plaintext is NEVER stored; only a SHA-256 hash. A key
-- borrows its owner's authority (app_user_id) intersected with `scopes`,
-- so deleting/blocking the owner transitively disables the key.
create table if not exists app_api_keys (
  id              uuid primary key default gen_random_uuid(),
  app_user_id     uuid not null references app_users(id) on delete cascade,
  organization_id uuid references app_organizations(id),
  name            text not null,
  key_prefix      text not null,
  key_hash        text not null unique,
  scopes          text[] not null default '{}',
  status          text not null default 'active',   -- active | revoked
  expires_at      timestamptz,
  last_used_at    timestamptz,
  last_used_ip    inet,
  created_by      uuid references app_users(id),
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_by      uuid references app_users(id),
  revoked_reason  text
);
create index if not exists idx_app_api_keys_user   on app_api_keys(app_user_id);
create index if not exists idx_app_api_keys_status  on app_api_keys(status);
create index if not exists idx_app_api_keys_org     on app_api_keys(organization_id);

-- Named machine identities (OAuth2 client-credentials principals). The
-- `app_user_id` points at a dedicated service user row so the same
-- status / membership gates apply.
create table if not exists app_oauth_clients (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null unique,
  client_secret_hash text not null,
  app_user_id        uuid not null references app_users(id) on delete cascade,
  organization_id    uuid references app_organizations(id),
  name               text not null,
  scopes             text[] not null default '{}',
  status             text not null default 'active',  -- active | revoked
  created_at         timestamptz not null default now(),
  created_by         uuid references app_users(id),
  revoked_at         timestamptz,
  revoked_by         uuid references app_users(id)
);
create index if not exists idx_app_oauth_clients_status on app_oauth_clients(status);

-- Revocation list for stateless JWTs killed before natural expiry. Rows
-- are purged once `expires_at` passes (the token would be rejected by the
-- signature/exp check anyway after that point).
create table if not exists app_revoked_tokens (
  jti         text primary key,
  expires_at  timestamptz not null,
  revoked_at  timestamptz not null default now(),
  reason      text
);
create index if not exists idx_app_revoked_tokens_exp on app_revoked_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- Permission catalog additions for credential governance (design §9).
-- Keep in sync with ADMIN_PERMISSION_CATALOG in src/lib/admin/permissions.ts.
-- ---------------------------------------------------------------------------
insert into app_permissions (key, description) values
  ('admin.apikeys.read',   'Read API keys across users and organizations'),
  ('admin.apikeys.manage', 'Revoke and manage any user''s API keys'),
  ('admin.clients.read',   'Read OAuth client registrations'),
  ('admin.clients.manage', 'Create, rotate, and revoke OAuth clients')
on conflict (key) do nothing;

-- Grant the new keys to every privileged role that should hold them:
-- the schema-provisioned `superuser` and the seed-provisioned
-- `admin.platform`. Existing deployments pick these up on the next
-- migrate; the seed (which sources ADMIN_PERMISSION_CATALOG) keeps
-- admin.platform in sync on re-run.
insert into app_role_permissions (role_id, permission_id)
select r.id, p.id
from app_roles r
cross join app_permissions p
where r.key in ('superuser', 'admin.platform')
  and p.key in (
    'admin.apikeys.read', 'admin.apikeys.manage',
    'admin.clients.read', 'admin.clients.manage'
  )
on conflict do nothing;
