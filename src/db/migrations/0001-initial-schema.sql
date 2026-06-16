-- 0001-initial-schema.sql
--
-- COMPLETE initial application database schema.
--
-- This single script provisions EVERY application-owned table, index,
-- and baseline row needed for a first-time database setup — there is
-- exactly ONE application schema file and ONE setup process. It is the
-- consolidation of every incremental migration the project has ever had:
-- the original core/indexes/audit/superuser/email migrations AND the
-- later machine-API credentials (`app_api_keys`, `app_oauth_clients`,
-- `app_revoked_tokens`, the `admin.apikeys.*` / `admin.clients.*`
-- permissions), all folded into one authoritative definition.
--
-- A fresh database needs only this file, plus the Better Auth vendor
-- schema applied by `pnpm db:auth:migrate`, and `pnpm db:seed` for the
-- local admin user and baseline roles. There are no other application
-- migration files and no further application migrations are required.
--
-- Scope note: the Better Auth tables (`user`, `session`, `account`,
-- `verification`, …) are owned and created by Better Auth's own
-- migration tooling — never hand-rolled here. This file covers all the
-- APPLICATION tables (the `app_*` namespace).
--
-- Fully idempotent: `create … if not exists` + `on conflict do nothing`
-- guards throughout, so applying it to an already-provisioned database
-- is a safe no-op.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
-- Installed into `public` (a shared location on the search_path) so a single
-- copy of gen_random_uuid() / gin_trgm_ops resolves from every application
-- schema. The application tables themselves live in DB_SCHEMA (default
-- `auth`), which the migration runner creates and sets as the search_path's
-- first entry before this file runs.
create extension if not exists "pgcrypto" with schema public; -- gen_random_uuid()
create extension if not exists "pg_trgm" with schema public;  -- trigram indexes for name/email search

-- ---------------------------------------------------------------------------
-- Core tables
-- ---------------------------------------------------------------------------

create table if not exists app_organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_provider_organizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id),
  provider text not null,
  provider_organization_key text not null,
  display_name text,
  created_at timestamptz not null default now(),
  unique (provider, provider_organization_key)
);

-- Application-side user profile. Links to Better Auth via
-- `better_auth_user_id` (unique). The soft-delete bookkeeping columns
-- (`deactivated_*`) capture who/when/why for the admin soft-delete flow.
create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  better_auth_user_id text not null unique,
  primary_email text not null,
  display_name text,
  status text not null default 'pending_approval',
  status_reason text,
  preferred_locale text not null default 'en',
  deactivated_at timestamptz,
  deactivated_by text,
  deactivated_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Membership of an app_user in an app_organization. `pre_deactivation_status`
-- snapshots the prior status during the admin soft-delete cascade so the
-- restore endpoint can return memberships to their previous state.
create table if not exists app_organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id),
  app_user_id uuid not null references app_users(id),
  status text not null default 'pending_approval',
  source_provider text,
  provider_organization_key text,
  pre_deactivation_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, app_user_id)
);

create table if not exists app_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references app_organizations(id),
  key text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (organization_id, key)
);

create table if not exists app_permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text
);

create table if not exists app_role_permissions (
  role_id uuid not null references app_roles(id),
  permission_id uuid not null references app_permissions(id),
  primary key (role_id, permission_id)
);

create table if not exists app_user_roles (
  app_user_id uuid not null references app_users(id),
  organization_id uuid not null references app_organizations(id),
  role_id uuid not null references app_roles(id),
  created_at timestamptz not null default now(),
  primary key (app_user_id, organization_id, role_id)
);

-- Organization groups (ADR-0002): a named cohort within ONE organization
-- (no global groups) that bundles roles and collects users. A user's
-- effective roles in an org = direct (app_user_roles) UNION via-groups.
create table if not exists app_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);

-- Roles a group confers. The route layer enforces that role_id belongs to
-- the SAME org as the group (no global/foreign-org roles); the FK only
-- guarantees referential integrity.
create table if not exists app_group_roles (
  group_id uuid not null references app_groups(id) on delete cascade,
  role_id uuid not null references app_roles(id) on delete cascade,
  primary key (group_id, role_id)
);

-- Users that belong to a group (binary membership in v1).
create table if not exists app_group_memberships (
  group_id uuid not null references app_groups(id) on delete cascade,
  app_user_id uuid not null references app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, app_user_id)
);

create table if not exists app_enterprise_applications (
  id text primary key,
  organization_id uuid references app_organizations(id),
  label text not null,
  description text,
  origin text not null,
  subdomain text not null,
  sso_audience text not null,
  status text not null default 'available',
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists app_sso_handoff_nonces (
  jti text primary key,
  app_user_id uuid not null references app_users(id),
  target_application_id text not null references app_enterprise_applications(id),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Structured audit log. `request_id` correlates each row to the
-- originating request via the `x-request-id` response header.
create table if not exists app_audit_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  outcome text not null,
  actor_better_auth_user_id text,
  app_user_id uuid references app_users(id),
  organization_id uuid references app_organizations(id),
  target_application_id text,
  provider text,
  email text,
  ip_address inet,
  user_agent text,
  reason text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists app_user_locale_preferences (
  app_user_id uuid primary key references app_users(id),
  locale text not null default 'en',
  time_zone text,
  date_format text,
  number_format_locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Editable email templates keyed by (key, locale). Seeded below with the
-- built-in defaults; the runtime falls back to the code-level defaults in
-- `src/lib/email/templates.ts` when a row is missing, so removing a row
-- can never break a flow.
create table if not exists app_email_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  locale text not null default 'en',
  subject text not null,
  body_html text not null,
  body_text text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key, locale)
);

-- Outbox-first email log: every outbound email is recorded here BEFORE
-- any delivery attempt. With no provider configured, rows stay `logged`.
create table if not exists app_outbox (
  id uuid primary key default gen_random_uuid(),
  -- Owning tenant (ADR-0001). Nullable: platform/system emails and
  -- multi-org-ambiguous emails stay org-less and are SUPERADMIN-only to
  -- read; an org-attributed row is readable by that org's admins. `on
  -- delete set null` keeps the historical row if the org is removed.
  organization_id uuid references app_organizations(id) on delete set null,
  template_key text,
  to_email text not null,
  from_email text not null,
  subject text not null,
  body_html text not null,
  body_text text,
  variables jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'logged')),
  provider text,
  provider_message_id text,
  error text,
  related_better_auth_user_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Status filters.
create index if not exists idx_app_users_status
  on app_users (status);
create index if not exists idx_app_memberships_status
  on app_organization_memberships (status);

-- Hot list-view sort/filter paths.
create index if not exists idx_app_users_created_at_desc
  on app_users (created_at desc);

-- Membership / role lookup paths used by the user-detail tabs.
create index if not exists idx_app_memberships_app_user_id
  on app_organization_memberships (app_user_id);
create index if not exists idx_app_memberships_org_status
  on app_organization_memberships (organization_id, status);
create index if not exists idx_app_user_roles_app_user_id
  on app_user_roles (app_user_id);
create index if not exists idx_app_user_roles_role_id
  on app_user_roles (role_id);
-- Group resolution (ADR-0002): list a user's groups, a group's members, and
-- the reverse role->group lookup.
create index if not exists idx_app_groups_organization_id
  on app_groups (organization_id);
create index if not exists idx_app_group_roles_role_id
  on app_group_roles (role_id);
create index if not exists idx_app_group_memberships_user
  on app_group_memberships (app_user_id);
-- Reverse lookup on the role->permission junction. The composite PK is
-- leftmost on role_id, so a predicate on permission_id alone (e.g. the
-- `used_by_role_count` correlated sub-select in the permissions grid)
-- cannot seek it. Mirrors the both-directions indexing of app_user_roles.
create index if not exists idx_app_role_permissions_permission_id
  on app_role_permissions (permission_id);

-- Trigram GIN indexes power the global-search box (case-insensitive
-- substring match against email / name) without sequential scans.
create index if not exists idx_app_users_primary_email_trgm
  on app_users using gin (primary_email gin_trgm_ops);
create index if not exists idx_app_users_display_name_trgm
  on app_users using gin (display_name gin_trgm_ops);
-- The same `ilike '%q%'` substring search backs every admin grid's search
-- box (and the matching CSV export), so give each high-cardinality searched
-- column its own trigram index — otherwise the list/export queries seq-scan
-- the whole table on every keystroke. Low-cardinality searched columns
-- (event_type, template_key, subdomain) and tiny tables (the ~30-row
-- permission catalog, api keys) are intentionally left to seq-scan: a
-- trigram index there only adds write cost without selective benefit.
create index if not exists idx_app_organizations_slug_trgm
  on app_organizations using gin (slug gin_trgm_ops);
create index if not exists idx_app_organizations_name_trgm
  on app_organizations using gin (name gin_trgm_ops);
create index if not exists idx_app_roles_key_trgm
  on app_roles using gin (key gin_trgm_ops);
create index if not exists idx_app_roles_name_trgm
  on app_roles using gin (name gin_trgm_ops);
create index if not exists idx_app_enterprise_applications_label_trgm
  on app_enterprise_applications using gin (label gin_trgm_ops);
create index if not exists idx_app_outbox_to_email_trgm
  on app_outbox using gin (to_email gin_trgm_ops);
create index if not exists idx_app_outbox_subject_trgm
  on app_outbox using gin (subject gin_trgm_ops);
create index if not exists idx_app_audit_events_email_trgm
  on app_audit_events using gin (email gin_trgm_ops);
create index if not exists idx_app_audit_events_reason_trgm
  on app_audit_events using gin (reason gin_trgm_ops);

-- Audit-explorer indexes.
create index if not exists idx_app_audit_events_type_created_at
  on app_audit_events (event_type, created_at desc);
create index if not exists idx_app_audit_events_created_at_desc
  on app_audit_events (created_at desc);
create index if not exists idx_app_audit_events_actor_created_at
  on app_audit_events (actor_better_auth_user_id, created_at desc);
create index if not exists idx_app_audit_events_request_id
  on app_audit_events (request_id)
  where request_id is not null;
-- Org-scoped audit reads (ADR-0001): an org admin's audit view filters to
-- their org. This composite serves that `organization_id` filter AND the
-- default `created_at desc` sort in one index scan (mirrors the sibling
-- `idx_app_outbox_organization_id` so the two log tables stay symmetric).
create index if not exists idx_app_audit_events_org_created_at
  on app_audit_events (organization_id, created_at desc);

-- Outbox explorer.
create index if not exists idx_app_outbox_created_at_desc
  on app_outbox (created_at desc);
create index if not exists idx_app_outbox_status
  on app_outbox (status);
-- Org-scoped outbox reads (ADR-0001): an org admin filters to their org.
create index if not exists idx_app_outbox_organization_id
  on app_outbox (organization_id);

-- ---------------------------------------------------------------------------
-- Machine API credentials (design docs/design-api-keys-and-tokens.md §4):
-- API keys, OAuth2 client-credentials principals, and a JWT revocation list
-- for the versioned `/api/v1` surface. Disabled by default at runtime
-- (API_KEYS_ENABLED / API_JWT_ENABLED) — the tables exist regardless.
-- ---------------------------------------------------------------------------

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
-- Baseline data: default organization, permission catalog, superuser role
-- ---------------------------------------------------------------------------
-- These rows let a migrated-but-not-yet-seeded database already recognise
-- the administrator surface. `pnpm db:seed` layers the remaining baseline
-- roles (member / admin / admin.platform), the enterprise application
-- catalog, and the local Better Auth admin user on top.

-- Default organization (also created by the seed; created here so the
-- schema is self-contained even before any seed has run).
insert into app_organizations (slug, name, status, is_default)
values ('default', 'Default Organization', 'active', true)
on conflict (slug) do nothing;

-- Permission catalog. The `superuser` marker is not individually checked
-- at runtime (the role's power comes from holding every other key); the
-- canonical `admin.*` catalog MUST stay in sync with
-- `ADMIN_PERMISSION_CATALOG` in `src/lib/admin/permissions.ts` — the
-- runtime check, the seed script, and this schema share the same keys.
insert into app_permissions (key, description) values
  ('superuser', 'Superuser access level — full unrestricted access to every part of the application'),
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
  ('admin.audit.read', 'Read the audit event log'),
  ('admin.email.read', 'Read the email outbox and templates'),
  ('admin.email.manage', 'Edit email templates and send test emails'),
  ('admin.apikeys.read', 'Read API keys across users and organizations'),
  ('admin.apikeys.manage', 'Revoke and manage any user''s API keys'),
  ('admin.clients.read', 'Read OAuth client registrations'),
  ('admin.clients.manage', 'Create, rotate, and revoke OAuth clients')
on conflict (key) do nothing;

-- Superuser role on the default organization.
insert into app_roles (organization_id, key, name, description)
select
  o.id,
  'superuser',
  'Superuser',
  'Default superuser access level. Holds every permission, including all administrator capabilities.'
from app_organizations o
where o.slug = 'default'
on conflict (organization_id, key) do nothing;

-- Grant the superuser role only the `superuser` MARKER. Post-hardening
-- (PR #97) a superuser's authority derives from the marker: the runtime
-- (getUserAccessContext) synthesizes the full permission set for any holder
-- and the admin permission gate short-circuits on isSuperadmin — so
-- enumerating the whole catalog onto the role is redundant. (shell.view is
-- not part of this schema's catalog; the seed grants it and the runtime
-- synthesis supplies it.)
insert into app_role_permissions (role_id, permission_id)
select r.id, p.id
from app_roles r
join app_organizations o on o.id = r.organization_id
join app_permissions p on p.key = 'superuser'
where o.slug = 'default'
  and r.key = 'superuser'
on conflict do nothing;

-- Default email templates. Keep keys + variables in sync with
-- `DEFAULT_EMAIL_TEMPLATES` in `src/lib/email/templates.ts`.
insert into app_email_templates (key, locale, subject, body_html, body_text, description) values
  (
    'password_reset',
    'en',
    'Reset your password',
    '<p>Hi {{name}},</p><p>We received a request to reset your password. Click the link below to choose a new one. This link expires shortly.</p><p><a href="{{resetUrl}}">Reset your password</a></p><p>If you did not request this, you can safely ignore this email.</p>',
    E'Hi {{name}},\n\nWe received a request to reset your password. Open the link below to choose a new one. This link expires shortly.\n\n{{resetUrl}}\n\nIf you did not request this, you can safely ignore this email.',
    'Sent for the forgot-password flow and the administrator "send reset email" action. Variables: {{name}}, {{resetUrl}}.'
  ),
  (
    'test_email',
    'en',
    'Test email from {{appName}}',
    '<p>This is a test email sent from the {{appName}} administrator Email workspace by {{sentBy}}.</p><p>If you can read this, outbound email delivery is working.</p>',
    E'This is a test email sent from the {{appName}} administrator Email workspace by {{sentBy}}.\n\nIf you can read this, outbound email delivery is working.',
    'Sent by the administrator "send test email" action. Variables: {{appName}}, {{sentBy}}.'
  )
on conflict (key, locale) do nothing;

-- ---------------------------------------------------------------------------
-- Default admin provisioning (backfill)
-- ---------------------------------------------------------------------------
-- If a Better Auth identity for the canonical local admin already exists,
-- provision the matching application-side rows and assign the superuser
-- (and, when present, admin / admin.platform) roles. On a fresh install
-- the Better Auth user does not exist yet — it is created by
-- `pnpm db:seed`, which performs the same wiring. This block is therefore
-- a no-op pre-seed and a backfill if re-run afterward.
do $$
declare
  v_default_org_id uuid;
  v_admin_role_id uuid;
  v_platform_role_id uuid;
  v_superuser_role_id uuid;
  v_better_auth_user_id text;
  v_better_auth_email text;
  v_better_auth_name text;
  v_app_user_id uuid;
  v_has_user_table boolean;
  v_has_role_column boolean;
begin
  select exists (
    select 1
    from information_schema.tables
    where table_schema = current_schema()
      and table_name = 'user'
  ) into v_has_user_table;

  if not v_has_user_table then
    raise notice '[initial-schema] Better Auth "user" table not found; skipping default-admin provisioning. Run pnpm db:auth:migrate (Better Auth schema) and then pnpm db:seed to create admin@devresponse.local; the seed will assign the superuser role.';
    return;
  end if;

  execute $sql$
    select id, email, name
    from "user"
    where lower(email) = lower('admin@devresponse.local')
    limit 1
  $sql$
  into v_better_auth_user_id, v_better_auth_email, v_better_auth_name;

  if v_better_auth_user_id is null then
    raise notice '[initial-schema] Better Auth user admin@devresponse.local does not exist yet; superuser role created but user-side wiring will be completed by pnpm db:seed.';
    return;
  end if;

  select id into v_default_org_id
  from app_organizations
  where slug = 'default';

  select id into v_admin_role_id
  from app_roles
  where organization_id = v_default_org_id and key = 'admin';

  select id into v_platform_role_id
  from app_roles
  where organization_id = v_default_org_id and key = 'admin.platform';

  select id into v_superuser_role_id
  from app_roles
  where organization_id = v_default_org_id and key = 'superuser';

  insert into app_users (
    better_auth_user_id,
    primary_email,
    display_name,
    status,
    status_reason,
    preferred_locale
  )
  values (
    v_better_auth_user_id,
    v_better_auth_email,
    coalesce(v_better_auth_name, 'Local Admin'),
    'active',
    null,
    'en'
  )
  on conflict (better_auth_user_id) do update set
    primary_email = excluded.primary_email,
    display_name = coalesce(excluded.display_name, app_users.display_name),
    status = 'active',
    status_reason = null,
    updated_at = now()
  returning id into v_app_user_id;

  -- Mirror the Better Auth admin-plugin role flag when the column exists,
  -- so the vendor admin endpoints recognise the user as well.
  select exists (
    select 1
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'user'
      and column_name = 'role'
  ) into v_has_role_column;

  if v_has_role_column then
    execute $sql$ update "user" set role = 'admin' where id = $1 $sql$
      using v_better_auth_user_id;
  end if;

  insert into app_organization_memberships (
    organization_id,
    app_user_id,
    status,
    source_provider,
    provider_organization_key
  )
  values (v_default_org_id, v_app_user_id, 'active', 'email', 'default')
  on conflict (organization_id, app_user_id) do update set
    status = 'active',
    source_provider = excluded.source_provider,
    provider_organization_key = excluded.provider_organization_key,
    updated_at = now();

  if v_admin_role_id is not null then
    insert into app_user_roles (app_user_id, organization_id, role_id)
    values (v_app_user_id, v_default_org_id, v_admin_role_id)
    on conflict do nothing;
  end if;

  if v_platform_role_id is not null then
    insert into app_user_roles (app_user_id, organization_id, role_id)
    values (v_app_user_id, v_default_org_id, v_platform_role_id)
    on conflict do nothing;
  end if;

  if v_superuser_role_id is not null then
    insert into app_user_roles (app_user_id, organization_id, role_id)
    values (v_app_user_id, v_default_org_id, v_superuser_role_id)
    on conflict do nothing;
  end if;

  raise notice '[initial-schema] provisioned admin@devresponse.local with admin + admin.platform + superuser roles on the default organization.';
end
$$;
