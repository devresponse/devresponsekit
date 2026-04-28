create extension if not exists "pgcrypto";

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

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  better_auth_user_id text not null unique,
  primary_email text not null,
  display_name text,
  status text not null default 'pending_approval',
  status_reason text,
  preferred_locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id),
  app_user_id uuid not null references app_users(id),
  status text not null default 'pending_approval',
  source_provider text,
  provider_organization_key text,
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

create index if not exists idx_app_audit_events_type_created_at
  on app_audit_events (event_type, created_at desc);

create index if not exists idx_app_users_status
  on app_users (status);

create index if not exists idx_app_memberships_status
  on app_organization_memberships (status);
