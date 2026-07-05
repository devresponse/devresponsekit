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
