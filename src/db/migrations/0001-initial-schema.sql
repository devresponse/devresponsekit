-- 0001-initial-schema.sql
--
-- COMPLETE initial application database schema.
--
-- This single script provisions EVERY application-owned table, index,
-- and baseline row needed for a first-time database setup — there is
-- exactly ONE application schema file and ONE setup process. It is the
-- consolidation of every incremental migration the project has ever had:
-- the original core/indexes/audit/superuser migrations, the machine-API
-- credentials (`app_api_keys`, `app_oauth_clients`, `app_revoked_tokens`,
-- the `admin.apikeys.*` / `admin.clients.*` permissions), AND the former
-- standalone forward migrations — the SSO nonce-expiry index (was 0002),
-- the outbox retry lifecycle (0003), the audit append-only trigger (0004),
-- the organization-FK ON DELETE SET NULL swap (0005), per-org auth settings
-- (0007), and organization invitations (0008) — all folded into one
-- authoritative definition, applied in their original order (see the
-- "Folded in from …" section markers below).
--
-- A fresh database needs this file (plus the Better Auth vendor schema
-- applied by `pnpm db:auth:migrate`, and `pnpm db:seed` for the local admin
-- user and baseline roles). Email templates are NOT here — they live under
-- `locales/`, with the always-applied English base in
-- `locales/0000-email-templates-en.sql`.
--
-- This file is FROZEN: never edit its DDL. `create … if not exists` is a
-- no-op against an existing table, so changes here cannot alter a
-- provisioned database. Append schema changes as new numbered `NNNN-*.sql`
-- files (see run-migrations.ts). 0001–0009 are used/retired, so the next
-- forward migration is 0010.
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

-- Email templates are NOT seeded here. Every email template — including the
-- English base rows — lives with its locale under `locales/`: the en BASE rows
-- in `locales/0000-email-templates-en.sql` (ALWAYS applied, even when
-- DB_MIGRATE_LOCALES excludes the localized files) and the localized rows in
-- `locales/0001-email-templates-<loc>.sql`+. This keeps every template for a
-- given locale in exactly one file. See migration-plan.ts for the always-on
-- 0000 handling.

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


-- ===========================================================================
-- Folded in from 0002-sso-nonce-expires-index.sql
-- (was a separate forward migration; consolidated into this baseline to keep
-- the core setup a single file / single transaction — applied in original order).
-- ===========================================================================

-- 0002-sso-nonce-expires-index.sql
--
-- FIRST forward migration after the consolidated 0001 baseline.
--
-- Convention (see run-migrations.ts): 0001 is now FROZEN — never edit its DDL.
-- Schema changes land as new `NNNN-*.sql` files like this one; the runner
-- applies any not-yet-applied file in lexical order inside a transaction and
-- records it in `app_schema_migrations`, so each runs at most once and a
-- fresh DB applies 0001 then 0002 in order. Files must be append-only and
-- idempotent (`if not exists` / `on conflict do nothing`) so re-running the
-- runner against a provisioned DB is a safe no-op.
--
-- This migration adds the index backing the SSO handoff-nonce expiry prune.
-- Every SSO launch issues `delete from app_sso_handoff_nonces where
-- expires_at < ...` (src/lib/sso.server.ts) on a hot auth path; without this
-- index that prune sequentially scans the table. Runs on the runner's
-- DB_SCHEMA search_path, matching 0001's conventions.
create index if not exists idx_app_sso_handoff_nonces_expires_at
  on app_sso_handoff_nonces (expires_at);


-- ===========================================================================
-- Folded in from 0003-outbox-retry.sql
-- (was a separate forward migration; consolidated into this baseline to keep
-- the core setup a single file / single transaction — applied in original order).
-- ===========================================================================

-- 0003-outbox-retry.sql
--
-- Forward migration (see run-migrations.ts; 0001 is frozen). Append-only and
-- idempotent.
--
-- Gives app_outbox a retry lifecycle so transient delivery failures are
-- re-attempted instead of silently dropped (review D1). Statuses are unchanged
-- ('pending' | 'sent' | 'failed' | 'logged'): a still-retryable row stays
-- 'pending' with a future `next_attempt_at`; it only becomes terminal 'failed'
-- once `attempts` hits the worker's cap. The outbox drainer
-- (src/lib/email/outbox-worker.server.ts) claims due rows
-- (status='pending' AND next_attempt_at <= now) FOR UPDATE SKIP LOCKED.
alter table app_outbox add column if not exists attempts integer not null default 0;
alter table app_outbox add column if not exists next_attempt_at timestamptz;
alter table app_outbox add column if not exists last_attempt_at timestamptz;

-- Claim index for the drainer: due pending rows, oldest-scheduled first. Partial
-- on status so it stays small (sent/failed/logged rows are excluded).
create index if not exists idx_app_outbox_due
  on app_outbox (next_attempt_at)
  where status = 'pending';


-- ===========================================================================
-- Folded in from 0004-audit-append-only.sql
-- (was a separate forward migration; consolidated into this baseline to keep
-- the core setup a single file / single transaction — applied in original order).
-- ===========================================================================

-- 0004-audit-append-only.sql
--
-- Forward migration (see run-migrations.ts; 0001 is frozen). Append-only and
-- idempotent.
--
-- B3: make app_audit_events tamper-evident. The audit log is a compliance
-- record, so the application database role must not be able to silently UPDATE
-- or DELETE rows. A row-level BEFORE trigger raises on any UPDATE/DELETE,
-- enforcing append-only semantics at the database — independent of any
-- application-layer discipline.
--
-- The ONE sanctioned exception is the D3 retention job
-- (src/lib/retention.server.ts), which sets `app.audit_retention = 'on'` (via
-- SET LOCAL, transaction-scoped) immediately before pruning rows older than the
-- retention window. So aged rows can still be reaped, but only by that explicit
-- path — a stray UPDATE or an ad-hoc DELETE is rejected. INSERTs are unaffected.
-- The two changes are order-independent: until this trigger exists, the D3 flag
-- is a harmless no-op.

create or replace function app_audit_events_block_mutation()
  returns trigger
  language plpgsql
as $$
begin
  -- Sanctioned retention deletes opt in via a transaction-local GUC. The
  -- `true` makes current_setting return NULL (not error) when it is unset.
  if tg_op = 'DELETE' and current_setting('app.audit_retention', true) = 'on' then
    return old;
  end if;
  raise exception 'app_audit_events is append-only: % is not permitted', tg_op
    using errcode = 'check_violation',
          hint = 'Audit rows are immutable; aged rows are removed only by the retention job.';
end;
$$;

drop trigger if exists trg_app_audit_events_append_only on app_audit_events;
create trigger trg_app_audit_events_append_only
  before update or delete on app_audit_events
  for each row
  execute function app_audit_events_block_mutation();


-- ===========================================================================
-- Folded in from 0005-organizations-fk-on-delete.sql
-- (was a separate forward migration; consolidated into this baseline to keep
-- the core setup a single file / single transaction — applied in original order).
-- ===========================================================================

-- 0005-organizations-fk-on-delete.sql
--
-- Forward migration (see run-migrations.ts; 0001 is frozen). Append-only and
-- idempotent.
--
-- DB-1: deleting an organization used to raise an *unhandled* foreign-key 500.
-- Every org PATCH writes an `app_audit_events` row tagged with the org id, and
-- that FK had no ON DELETE action (= NO ACTION = blocks), so a member-less,
-- previously-edited org could never be deleted without a raw 500. The DELETE
-- guards only check `app_organization_memberships`, never the audit/role/binding
-- references.
--
-- The fix has two halves; the route change (FK violation -> 409
-- `organization_in_use`, mirroring enterprise-apps) and this migration:
--
--   1. app_audit_events.organization_id -> ON DELETE SET NULL. Audit is a
--      historical record: when its org is removed the event row must SURVIVE
--      with a null tenant (the 0001 schema comment already documents this
--      intent). This makes the common case — an org with only audit history —
--      deletable instead of a 500.
--
--   2. Teach the 0004 append-only trigger to permit EXACTLY that SET NULL
--      tombstone. The trigger (B3) rejects every UPDATE/DELETE on
--      app_audit_events, which would otherwise turn the SET NULL cascade into a
--      `check_violation` and re-break org deletion. The narrow exception below
--      allows only an UPDATE that nulls organization_id with every other column
--      byte-identical — so audit history survives org removal while the
--      tamper-evidence guarantee on row CONTENT is fully preserved.
--
-- Every OTHER org reference (app_roles, app_user_roles, app_provider_organizations,
-- app_enterprise_applications, app_api_keys, app_oauth_clients) intentionally
-- keeps its default RESTRICT/NO ACTION behavior: an org that still owns those
-- is genuinely "in use", so the DELETE raises a FK violation that the route now
-- translates to a clean 409 instead of a 500. (app_groups already CASCADEs and
-- app_outbox already SET NULLs per 0001.)

-- 1. Permit the org-deletion tombstone in the append-only trigger.
create or replace function app_audit_events_block_mutation()
  returns trigger
  language plpgsql
as $$
begin
  -- Sanctioned retention deletes opt in via a transaction-local GUC. The
  -- `true` makes current_setting return NULL (not error) when it is unset.
  if tg_op = 'DELETE' and current_setting('app.audit_retention', true) = 'on' then
    return old;
  end if;
  -- DB-1: an org DELETE fires `update app_audit_events set organization_id = null`
  -- via the ON DELETE SET NULL cascade below. Permit ONLY that exact tombstone —
  -- organization_id non-null -> null with EVERY other column unchanged — so the
  -- historical row is preserved (just detached from the deleted tenant) without
  -- opening any path to mutate audit content.
  if tg_op = 'UPDATE'
     and old.organization_id is not null
     and new.organization_id is null
     and (to_jsonb(new) - 'organization_id') = (to_jsonb(old) - 'organization_id') then
    return new;
  end if;
  raise exception 'app_audit_events is append-only: % is not permitted', tg_op
    using errcode = 'check_violation',
          hint = 'Audit rows are immutable; aged rows are removed only by the retention job.';
end;
$$;

-- 2. Flip app_audit_events.organization_id to ON DELETE SET NULL. The 0001 FK is
-- inline/unnamed; find it by its target + column rather than guessing the
-- autogenerated name, drop it, and re-add with a stable name + the SET NULL rule.
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'app_audit_events'
    and con.contype = 'f'
    and con.confrelid = 'app_organizations'::regclass
    and (
      select attname
      from pg_attribute
      where attrelid = con.conrelid and attnum = con.conkey[1]
    ) = 'organization_id';
  if cname is not null then
    execute format('alter table app_audit_events drop constraint %I', cname);
  end if;
end $$;

alter table app_audit_events
  add constraint app_audit_events_organization_id_fkey
  foreign key (organization_id) references app_organizations(id) on delete set null;


-- ===========================================================================
-- Folded in from 0007-organization-auth-settings.sql
-- (was a separate forward migration; consolidated into this baseline to keep
-- the core setup a single file / single transaction — applied in original order).
-- ===========================================================================

-- 0007-organization-auth-settings.sql
--
-- Forward migration (see run-migrations.ts; 0001 is frozen). Append-only and
-- idempotent.
--
-- Runtime-configurable per-organization signup/authentication policy. Until
-- now the signup workflow was hardcoded in two places: email verification via
-- `requireEmailVerification: true` (src/lib/auth.ts) and admin approval via
-- the `pending_approval` literals in user-provisioning.server.ts. This table
-- makes both decisions data-driven so different organizations can run
-- different registration workflows:
--
--   require_email_verification  - email/password sign-ups must confirm their
--                                  address before signing in (OAuth identities
--                                  arrive provider-verified and are unaffected).
--   signup_approval_mode         - 'admin_approval': new members start
--                                  `pending_approval` until an administrator
--                                  activates them (today's behavior).
--                                  'auto_active': new members are activated
--                                  immediately on provisioning.
--   allowed_auth_methods         - NULL = every enabled method; otherwise the
--                                  subset of {email,google,microsoft,github}
--                                  this org accepts. A sign-up via an excluded
--                                  method still provisions but is parked in
--                                  `pending_approval` (never silently dropped).
--   auto_approve_email_domains   - NULL = none; otherwise lowercased email
--                                  domains whose VERIFIED addresses activate
--                                  immediately even under 'admin_approval'.
--                                  Only honored for verified emails, so an
--                                  unproven address can never ride a domain
--                                  into an active membership.
--
-- Resolution order (src/lib/auth-policy.server.ts): the org's row if present,
-- else the single platform-default row (organization_id IS NULL), else
-- fail-closed code constants equal to today's behavior. An org row is a
-- COMPLETE policy - there is no per-field inheritance - which keeps the
-- resolver and the admin UI trivially explainable.
--
-- ON DELETE CASCADE: a policy row is wholly owned by its organization and
-- must never block org deletion (unlike roles/keys, which mean the org is
-- genuinely "in use" and correctly RESTRICT - see 0005).

create table if not exists app_organization_auth_settings (
  id uuid primary key default gen_random_uuid(),
  -- NULL = the platform-default row (exactly one, enforced below).
  organization_id uuid unique references app_organizations(id) on delete cascade,
  require_email_verification boolean not null,
  signup_approval_mode text not null
    check (signup_approval_mode in ('admin_approval', 'auto_active')),
  allowed_auth_methods text[]
    check (allowed_auth_methods <@ array['email', 'google', 'microsoft', 'github']::text[]),
  auto_approve_email_domains text[],
  -- Better Auth user id of the last editor (admin UI/API arrives in a
  -- follow-up; seeds and migrations leave this NULL).
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Postgres UNIQUE treats NULLs as distinct, so the column constraint above
-- does not bound the platform-default row. This partial index pins it to
-- exactly one.
create unique index if not exists idx_app_org_auth_settings_platform_default
  on app_organization_auth_settings ((true))
  where organization_id is null;

-- Seed the platform default to EXACTLY the previously hardcoded behavior
-- (verification required + admin approval), so applying this migration
-- changes nothing until an administrator edits a policy.
insert into app_organization_auth_settings
  (organization_id, require_email_verification, signup_approval_mode)
select null, true, 'admin_approval'
where not exists (
  select 1 from app_organization_auth_settings where organization_id is null
);


-- ===========================================================================
-- Folded in from 0008-organization-invitations.sql
-- (was a separate forward migration; consolidated into this baseline to keep
-- the core setup a single file / single transaction — applied in original order).
-- ===========================================================================

-- 0008-organization-invitations.sql
--
-- Forward migration (see run-migrations.ts; 0001 is frozen). Append-only and
-- idempotent.
--
-- Organization invitations: an administrator invites an email address into an
-- organization (optionally with an app role); the invitee receives a
-- single-use accept link. Accepting creates/activates the membership in the
-- INVITING org — the invitation is the approval, so it bypasses the
-- pending-approval queue. Composes with the 0007 signup policy via the new
-- `invite_only` approval mode (below): uninvited sign-ups park in
-- `pending_approval`, invited ones activate.
--
-- Token model (mirrors app_api_keys, src/lib/api-auth/api-key.ts): the
-- plaintext is a 32-char base62 CSPRNG secret that exists only inside the
-- invitation email; ONLY its SHA-256 hex is stored, unique-indexed for O(1)
-- lookup. High-entropy secret ⇒ fast hash is correct (bcrypt/argon2 exist to
-- slow low-entropy password guessing, which does not apply).
--
-- Status lifecycle: pending → accepted | revoked. `expired` is a terminal
-- status value reserved for explicit sweeps; live code treats a `pending` row
-- with `expires_at <= now()` as expired at READ time, so no sweeper is needed
-- for correctness.

create table if not exists app_organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  -- Invitee address, lowercased at write time. Acceptance requires the
  -- account's email to equal this value (invitation-forwarding cannot
  -- transfer the seat to another mailbox).
  email text not null,
  -- Optional app role granted on acceptance. Must belong to the same org
  -- (route-enforced); if the role is deleted meanwhile the invitation
  -- degrades to a plain membership (SET NULL).
  role_id uuid references app_roles(id) on delete set null,
  token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid references app_users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_app_user_id uuid references app_users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One PENDING invitation per (org, email): a resend rotates the existing
-- row's token instead of stacking duplicates.
create unique index if not exists idx_app_org_invitations_pending_unique
  on app_organization_invitations (organization_id, email)
  where status = 'pending';

create index if not exists idx_app_org_invitations_org_status
  on app_organization_invitations (organization_id, status);

-- ---------------------------------------------------------------------------
-- Extend the 0007 signup-policy approval modes with `invite_only`.
-- The 0007 CHECK was inline (auto-named); find it by definition rather than
-- guessing the generated name (same pattern as the 0005 FK swap), then
-- re-add under a stable name with the third value.
-- ---------------------------------------------------------------------------
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'app_organization_auth_settings'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%signup_approval_mode%';
  if cname is not null then
    execute format('alter table app_organization_auth_settings drop constraint %I', cname);
  end if;
end $$;

alter table app_organization_auth_settings
  add constraint app_organization_auth_settings_signup_approval_mode_check
  check (signup_approval_mode in ('admin_approval', 'auto_active', 'invite_only'));
