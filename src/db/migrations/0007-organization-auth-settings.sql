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
