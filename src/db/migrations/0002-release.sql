-- 0002-release.sql
--
-- The post-baseline changes of the 1.x/2.x line, consolidated on 2026-09-30:
-- the seven core migrations 0002 through 0008 that followed the frozen
-- baseline (`0001-initial-schema.sql`), folded into this one file so a new
-- database applies two core files, 0001 and this one, and then the email
-- templates under `locales/`. The last commit that still has the seven
-- individual files is 79b4803 (`git show 79b4803:src/db/migrations/<file>`).
--
-- WHAT IS HERE. The seven files follow in their original order, VERBATIM,
-- each with its own header comments, so "migration 0005" in a code comment,
-- a doc or a test names the 0005 section below. Nothing in them was edited:
-- every section still hashes (`migrationChecksum`) to the checksum its file
-- was ledgered under, which tests/unit/migration-checksums.test.ts proves by
-- splitting this file on its banners. Each section sits between two banner
-- lines in exactly this format (tests/helpers/core-migrations.ts parses it):
--
--   -- ===== BEGIN folded <legacy file> =====
--   -- ===== END folded <legacy file> =====
--
-- Read the sections' own comments as history. They describe the moment each
-- file first shipped: their LANDING ORDER notes, their "applies this file in
-- one transaction" and the runbooks they cite. This file as a whole is ONE
-- transaction: a preflight that raises (0005's, 0007's) rolls back every
-- section before it too, and every lock a section takes is held until the
-- whole file commits. That is harmless where it runs, on a new database.
--
-- EXISTING DATABASES. A database migrated before the consolidation has the
-- seven legacy ids in `app_schema_migrations`, not this one, and the runner
-- does NOT apply this file to it. When all seven are ledgered under their
-- pinned checksums (`CONSOLIDATED_CORE_MIGRATIONS`, migration-plan.ts) it
-- records this id and runs nothing; until then the readiness probe counts the
-- seven legacy ids as this one (`missingCoreMigrations`). A database holding
-- only SOME of them is refused before anything runs: migrate it from 79b4803
-- first (docs/deployment.md, "Upgrading a database from before the
-- consolidation"). This file is frozen like every applied migration.
--
-- Safe as one transaction (checked 2026-09-30): no CREATE INDEX CONCURRENTLY,
-- no ALTER TYPE … ADD VALUE, no transaction control, no top-level SET
-- (`set_config` only inside function bodies) and no deferred constraint. No
-- section needs an earlier one COMMITTED: a later section sees an earlier
-- one's catalog changes inside the transaction (0006's table gets the default
-- privileges 0005 declares), and on a new database neither preflight finds a
-- row to refuse. A dump of a database built from these sections is identical
-- to one built from the seven files one transaction each.

-- ===== BEGIN folded 0002-admin-groups-permissions.sql =====
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
-- ===== END folded 0002-admin-groups-permissions.sql =====

-- ===== BEGIN folded 0003-outbox-delivery-payload.sql =====
-- 0003-outbox-delivery-payload.sql
--
-- Outbox secret redaction (review #21). `sendAppEmail` now stores a REDACTED
-- rendering in `app_outbox.subject` / `body_html` / `body_text` / `variables`
-- (reset / verification / invitation tokens replaced by `[redacted]`), because
-- those columns feed the org-scoped administrator outbox API. The retry worker
-- still needs the real message, so the unredacted rendering is kept here —
-- ONLY for rows whose body actually carried a secret — and is nulled the
-- moment the row reaches a terminal `sent` / `failed` state.
--
-- Contract: no administrator route ever selects this column. It is DB-only
-- (the same trust boundary as Better Auth's own `verification` table, which
-- already holds the reset token in plaintext). Rows written before this
-- migration have `delivery_payload` null and their stored body IS the
-- deliverable, so the worker falls back to `body_html` / `body_text`.
--
-- Idempotent: `add column if not exists`.

alter table app_outbox add column if not exists delivery_payload jsonb;
-- ===== END folded 0003-outbox-delivery-payload.sql =====

-- ===== BEGIN folded 0004-oauth-client-secret-rotated-at.sql =====
-- 0004-oauth-client-secret-rotated-at.sql
--
-- Outstanding-token revocation for OAuth clients (review #43). Every JWT now
-- carries a `cid` claim naming the credential it was minted from, and the
-- caller resolver re-reads that credential's status on every request. For an
-- API key, revoke AND rotate both flip the row to `revoked`, so the check
-- alone retires the key's tokens. Rotating an OAuth client's SECRET, however,
-- re-hashes in place — the row stays `active` — so without a rotation stamp a
-- token minted with the OLD secret would remain valid until `exp`.
--
-- `secret_rotated_at` is written by `rotateOauthClientSecret`; the resolver
-- refuses a token whose `iat` precedes it. Null (never rotated) means every
-- token from an active client is honoured, so existing rows need no backfill.
--
-- Idempotent: `add column if not exists`. Nullable, no default, no backfill:
-- a metadata-only lock, safe to run against a live database.
--
-- LANDING ORDER (operator gate): apply this file to production BEFORE the
-- branch that ships it is merged — not "with" the deploy. Production deploys
-- from every push to `main` through Vercel's git integration and no automated
-- migrate step runs ahead of it (docs/deployment.md §1, "current state"),
-- while the resolver reads `secret_rotated_at` on EVERY request bearing an
-- OAuth-client JWT and `rotateOauthClientSecret` writes it. On a database
-- without the column those reads fail closed as 500s (an outage for every
-- client_credentials caller) and admin secret rotation 500s. Run
-- `pnpm db:app:migrate` against the production DATABASE_URL, confirm
-- `secret_rotated_at` exists on `app_oauth_clients`, then merge.
--
-- VERIFY, DON'T ASSUME: this file is in `REQUIRED_CORE_MIGRATIONS`
-- (migration-plan.ts), so once a build carrying it is live,
-- `GET /api/health/ready` answers 503 `{"reason":"schema_behind"}` until the
-- ledger records this id and 200 `{"status":"ready"}` afterwards — an
-- unauthenticated curl, no database access or client credentials needed.
-- Minting still succeeds without the column (verifyClientCredentials selects
-- an explicit column list), so a mint-only smoke test proves nothing; the
-- failure shows up on the first authenticated /api/v1 call.

alter table app_oauth_clients add column if not exists secret_rotated_at timestamptz;
-- ===== END folded 0004-oauth-client-secret-rotated-at.sql =====

-- ===== BEGIN folded 0005-integrity-constraints.sql =====
-- 0005-integrity-constraints.sql
--
-- Database-level integrity for invariants that were previously enforced only
-- in route code (source review 2026-09-04, Wave 3):
--
--   #15  UNIQUE index on app_enterprise_applications(sso_audience) — the
--        audience is what a satellite's consume route trusts; two rows sharing
--        one would let a token minted for either app reach the other. The
--        admin routes already refuse a duplicate with 409 `audience_taken`;
--        the index closes their check-then-write race.
--   #63  ONE state model for enterprise-app status: `degraded` (listed by the
--        switcher but rejected by launch and unknown to the validator) is
--        dropped everywhere; the CHECK pins `available` | `disabled`.
--   #217 CHECK constraints on every status/enum column of the identity and
--        credential tables, with the value lists copied VERBATIM from the
--        TypeScript enums (`src/lib/status-values.ts`) — a sync test parses
--        this file and diffs it against those arrays; plus
--        `email = lower(email)` on invitations (the routes lowercase at write
--        time; acceptance compares by equality).
--   #89  Indexes for the org-scoped OAuth-client paths and for every RI-checked
--        FK column that had none (a parent DELETE seq-scans the child table
--        otherwise). A DB test lists FK columns without a leading-column index.
--   #218 The same-organization invariant for app_group_roles / app_user_roles
--        moves into the schema: `unique (id, organization_id)` on groups and
--        roles, a backfilled `organization_id` on app_group_roles with
--        composite FKs (derived by a trigger from the group when a writer
--        omits it, so the pre-0005 build keeps working — see 4b), and on
--        app_user_roles a trigger-maintained `role_organization_id` with a
--        composite FK for org-scoped roles (global roles, organization_id IS
--        NULL, are exempt from the FK by MATCH SIMPLE and checked by the
--        trigger instead).
--   #83  Audit-table role split: a NOLOGIN runtime role (`<schema>_runtime`)
--        with INSERT/SELECT only on app_audit_events, retention as a
--        SECURITY DEFINER function owned by the migration/owner role, and an
--        append-only trigger that permits a DELETE only when the effective
--        role is the table OWNER *and* the transaction-local marker is on.
--        The marker alone (a bare GUC any session could SET) no longer
--        suffices, and a session connected as the runtime role can never
--        satisfy the owner half. A session connected AS THE OWNER — which is
--        what the application does until the operator switches DATABASE_URL
--        to the runtime role (Deployment §8) — can still set the marker and
--        delete: the guarantee is against the runtime credential, not the
--        schema owner (see 5c). The retention function clamps the caller's
--        window to an owner-owned floor (30 days) and caps the batch, so the
--        runtime credential cannot use it to purge recent history (see 5b).
--
-- Rollout shape: every CHECK is added NOT VALID and then VALIDATEd, and the
-- PREFLIGHT block below counts violating rows for EVERY new constraint first.
-- If any exist it raises with the full offender list (table, column, value,
-- count) and — because the runner applies this file in one transaction —
-- leaves the database unchanged. Nothing here edits data silently.
--
-- This file is NOT an online migration, and is not a pattern to copy (F-94).
-- NOT VALID + VALIDATE is online only when the two commit separately: ADD
-- CONSTRAINT takes ACCESS EXCLUSIVE on its table, and in one transaction that
-- lock is held until the whole file commits, so the cheap VALIDATE buys
-- nothing. The later sections add to it: ADD COLUMN, SET NOT NULL and DROP
-- TRIGGER take ACCESS EXCLUSIVE too (reads wait), and the foreign keys,
-- CREATE TRIGGER and the index builds take locks that block writes, all held
-- to the same commit. While it runs, every request that touches a table it
-- alters waits for it: app_users and the memberships on each access check,
-- app_audit_events on each audited write. Since F-94 the runner sets a
-- lock_timeout, so a file that cannot get a lock fails and rolls back instead
-- of queueing that traffic behind its wait; once it holds the locks, traffic
-- still waits for the rest of the file. docs/deployment.md §5 describes how
-- to write a migration that is safe to apply to a live database. The SQL
-- below stays as it is: it is applied and ledgered everywhere.
--
-- Forward-only; idempotent where cheap (`if not exists` / catalog-guarded
-- `do` blocks) so a partially-applied manual run can be repeated.

-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT — abort with the offender list if any row violates a
--    constraint this file is about to add. Runs first so nothing is changed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_offenders text[] := '{}';
  r record;
begin
  for r in
    select 'app_organizations' as tbl, 'status' as col, status as val, count(*) as n
    from app_organizations
    where status not in ('active', 'pending', 'suspended', 'archived')
    group by status
    union all
    select 'app_users', 'status', status, count(*)
    from app_users
    where status not in ('active', 'pending_approval', 'blocked', 'suspended', 'deactivated')
    group by status
    union all
    select 'app_organization_memberships', 'status', status, count(*)
    from app_organization_memberships
    where status not in ('active', 'pending_approval', 'blocked', 'suspended')
    group by status
    union all
    select 'app_organization_memberships', 'pre_deactivation_status', pre_deactivation_status, count(*)
    from app_organization_memberships
    where pre_deactivation_status is not null
      and pre_deactivation_status not in ('active', 'pending_approval', 'blocked', 'suspended')
    group by pre_deactivation_status
    union all
    select 'app_enterprise_applications', 'status', status, count(*)
    from app_enterprise_applications
    where status not in ('available', 'disabled')
    group by status
    union all
    select 'app_api_keys', 'status', status, count(*)
    from app_api_keys
    where status not in ('active', 'revoked')
    group by status
    union all
    select 'app_oauth_clients', 'status', status, count(*)
    from app_oauth_clients
    where status not in ('active', 'revoked')
    group by status
    union all
    select 'app_organization_invitations', 'email', email, count(*)
    from app_organization_invitations
    where email <> lower(email)
    group by email
    union all
    -- #15: an audience shared by two or more apps.
    select 'app_enterprise_applications', 'sso_audience', sso_audience, count(*)
    from app_enterprise_applications
    group by sso_audience
    having count(*) > 1
    union all
    -- #218: a group bundling a role from another org (or a global role).
    select 'app_group_roles', 'role_id', gr.role_id::text, count(*)
    from app_group_roles gr
    join app_groups g on g.id = gr.group_id
    join app_roles ro on ro.id = gr.role_id
    where ro.organization_id is distinct from g.organization_id
    group by gr.role_id
    union all
    -- #218: an org-scoped role assigned inside a different org.
    select 'app_user_roles', 'role_id', ur.role_id::text, count(*)
    from app_user_roles ur
    join app_roles ro on ro.id = ur.role_id
    where ro.organization_id is not null
      and ro.organization_id <> ur.organization_id
    group by ur.role_id
  loop
    v_offenders := v_offenders || format('%s.%s = %L (%s rows)', r.tbl, r.col, r.val, r.n);
  end loop;

  if array_length(v_offenders, 1) > 0 then
    raise exception '[0005] refusing to apply: % row group(s) violate a constraint this migration adds. Fix the data, then re-run. Offenders (table.column = value (count)): %',
      array_length(v_offenders, 1), array_to_string(v_offenders, '; ')
      using errcode = 'check_violation',
            hint = 'Nothing was changed. Review each offender, correct or remove the rows, and re-run pnpm db:app:migrate.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. #15 — unique SSO audience
-- ---------------------------------------------------------------------------
-- The admin create/update routes map a 23505 on THIS index name to
-- 409 `audience_taken` (distinct from the primary-key `id_taken`).
create unique index if not exists idx_app_enterprise_applications_sso_audience
  on app_enterprise_applications (sso_audience);

-- ---------------------------------------------------------------------------
-- 2. #63 / #217 — status CHECK constraints (NOT VALID, then VALIDATE)
-- ---------------------------------------------------------------------------
-- Each block: add the constraint only when absent (looked up by
-- `conrelid = '<table>'::regclass`, so a same-named constraint in another
-- schema is never mistaken for ours — review #88), then VALIDATE, which is a
-- no-op when it is already validated. The value lists MUST match
-- `src/lib/status-values.ts` verbatim — enforced by
-- tests/unit/migration-status-check-sync.test.ts.

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_organizations'::regclass and conname = 'app_organizations_status_check') then
    alter table app_organizations add constraint app_organizations_status_check
      check (status in ('active', 'pending', 'suspended', 'archived')) not valid;
  end if;
end $$;
alter table app_organizations validate constraint app_organizations_status_check;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_users'::regclass and conname = 'app_users_status_check') then
    alter table app_users add constraint app_users_status_check
      check (status in ('active', 'pending_approval', 'blocked', 'suspended', 'deactivated')) not valid;
  end if;
end $$;
alter table app_users validate constraint app_users_status_check;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_organization_memberships'::regclass and conname = 'app_organization_memberships_status_check') then
    alter table app_organization_memberships add constraint app_organization_memberships_status_check
      check (status in ('active', 'pending_approval', 'blocked', 'suspended')) not valid;
  end if;
end $$;
alter table app_organization_memberships validate constraint app_organization_memberships_status_check;

-- `pre_deactivation_status` is a nullable snapshot of `status` (soft-delete
-- cascade), so it takes the same vocabulary or NULL.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_organization_memberships'::regclass and conname = 'app_organization_memberships_pre_deactivation_status_check') then
    alter table app_organization_memberships add constraint app_organization_memberships_pre_deactivation_status_check
      check (pre_deactivation_status is null or pre_deactivation_status in ('active', 'pending_approval', 'blocked', 'suspended')) not valid;
  end if;
end $$;
alter table app_organization_memberships validate constraint app_organization_memberships_pre_deactivation_status_check;

-- #63: `degraded` is gone — the switcher lists `available` only, the
-- validator accepts `available` | `disabled`, and the column agrees.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_enterprise_applications'::regclass and conname = 'app_enterprise_applications_status_check') then
    alter table app_enterprise_applications add constraint app_enterprise_applications_status_check
      check (status in ('available', 'disabled')) not valid;
  end if;
end $$;
alter table app_enterprise_applications validate constraint app_enterprise_applications_status_check;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_api_keys'::regclass and conname = 'app_api_keys_status_check') then
    alter table app_api_keys add constraint app_api_keys_status_check
      check (status in ('active', 'revoked')) not valid;
  end if;
end $$;
alter table app_api_keys validate constraint app_api_keys_status_check;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_oauth_clients'::regclass and conname = 'app_oauth_clients_status_check') then
    alter table app_oauth_clients add constraint app_oauth_clients_status_check
      check (status in ('active', 'revoked')) not valid;
  end if;
end $$;
alter table app_oauth_clients validate constraint app_oauth_clients_status_check;

-- Invitations are matched to an account by email EQUALITY at acceptance; the
-- routes lowercase at write time, and the column now guarantees it.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_organization_invitations'::regclass and conname = 'app_organization_invitations_email_lower_check') then
    alter table app_organization_invitations add constraint app_organization_invitations_email_lower_check
      check (email = lower(email)) not valid;
  end if;
end $$;
alter table app_organization_invitations validate constraint app_organization_invitations_email_lower_check;

-- ---------------------------------------------------------------------------
-- 3. #89 — indexes
-- ---------------------------------------------------------------------------
-- The per-org client quota check and the org-scoped client list both filter
-- `app_oauth_clients` by organization_id (+ status); the only index was on
-- status alone.
create index if not exists idx_app_oauth_clients_org_status
  on app_oauth_clients (organization_id, status);
-- `on delete cascade` from app_users — the cascade (and the per-user client
-- list) seeks by app_user_id.
create index if not exists idx_app_oauth_clients_app_user_id
  on app_oauth_clients (app_user_id);
-- RI-checked FK columns with no leading-column index: a DELETE (or PK update)
-- on the parent scans the whole child table per row without these.
create index if not exists idx_app_org_invitations_role_id
  on app_organization_invitations (role_id);
create index if not exists idx_app_provider_organizations_organization_id
  on app_provider_organizations (organization_id);
create index if not exists idx_app_enterprise_applications_organization_id
  on app_enterprise_applications (organization_id);
create index if not exists idx_app_user_roles_organization_id
  on app_user_roles (organization_id);
-- app_audit_events.app_user_id is RI-checked on every app_users delete
-- against the largest table in the schema; it also backs the per-user audit
-- tab filter.
create index if not exists idx_app_audit_events_app_user_id
  on app_audit_events (app_user_id);

-- ---------------------------------------------------------------------------
-- 4. #218 — same-organization invariant for group roles / user roles
-- ---------------------------------------------------------------------------
-- 4a. Composite uniqueness so (id, organization_id) can be an FK target. The
--     id is already the primary key, so these add no new uniqueness — they
--     exist purely to let a child row pin the parent's org.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_groups'::regclass and conname = 'app_groups_id_organization_id_key') then
    alter table app_groups add constraint app_groups_id_organization_id_key unique (id, organization_id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_roles'::regclass and conname = 'app_roles_id_organization_id_key') then
    alter table app_roles add constraint app_roles_id_organization_id_key unique (id, organization_id);
  end if;
end $$;

-- 4b. app_group_roles carries the org of BOTH ends. Backfilled from the group
--     (the preflight proved every existing role already matches), then pinned
--     by two composite FKs: the row can only ever reference a group and a
--     role of that one org. A global role (organization_id IS NULL) can never
--     satisfy `(role_id, organization_id)` against app_roles(id, organization_id)
--     because organization_id is NOT NULL here — ADR-0002 says groups bundle
--     org roles only. Cascades mirror the original single-column FKs.
--
--     FORWARD-COMPAT (Deployment §2 promises migrate-first + rollback safety:
--     the build that is live while this file runs, and any build rolled back
--     to afterwards, inserts `{group_id, role_id}` only). A NOT NULL column
--     with no default would make that insert fail with 23502, so the column
--     is DERIVED in the database: the BEFORE trigger below fills
--     organization_id from the group whenever a writer leaves it NULL —
--     the mirror of the app_user_roles bind trigger in 4c. A writer that
--     does supply it (the post-0005 route) is left alone, and a wrong value
--     still fails on the composite FKs; the trigger fills a gap, it never
--     overrides an explicit claim. NOT NULL is then safe to add.
alter table app_group_roles add column if not exists organization_id uuid;
update app_group_roles gr
   set organization_id = g.organization_id
  from app_groups g
 where g.id = gr.group_id
   and gr.organization_id is null;

create or replace function app_group_roles_bind_org()
  returns trigger
  language plpgsql
as $$
begin
  if new.organization_id is null then
    select g.organization_id into new.organization_id
      from app_groups g
     where g.id = new.group_id;
    if not found then
      -- NOT NULL is checked right after BEFORE triggers, before any FK, so
      -- an unknown group would otherwise surface as a misleading 23502 on
      -- organization_id. Report the real cause with the FK's own identity.
      raise exception 'app_group_roles: group % does not exist', new.group_id
        using errcode = 'foreign_key_violation',
              constraint = 'app_group_roles_group_id_fkey';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_app_group_roles_bind_org on app_group_roles;
create trigger trg_app_group_roles_bind_org
  before insert or update of group_id, organization_id on app_group_roles
  for each row
  execute function app_group_roles_bind_org();

alter table app_group_roles alter column organization_id set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_group_roles'::regclass and conname = 'app_group_roles_group_org_fkey') then
    alter table app_group_roles add constraint app_group_roles_group_org_fkey
      foreign key (group_id, organization_id) references app_groups (id, organization_id) on delete cascade;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_group_roles'::regclass and conname = 'app_group_roles_role_org_fkey') then
    alter table app_group_roles add constraint app_group_roles_role_org_fkey
      foreign key (role_id, organization_id) references app_roles (id, organization_id) on delete cascade;
  end if;
end $$;

-- 4c. app_user_roles: `role_organization_id` mirrors the role's own org and is
--     maintained by the trigger below (write paths never set it). For an
--     org-scoped role the composite FK pins (role_id, role_organization_id)
--     to app_roles and the CHECK pins it to the membership org; for a GLOBAL
--     role the mirror is NULL, so the FK is skipped (MATCH SIMPLE) and the
--     CHECK passes — global roles may be assigned in any org, which is what
--     `organization_id IS NULL` means. The trigger raises a clear error for a
--     cross-org assignment BEFORE the CHECK would, and re-derives the mirror
--     on every insert/update so it can never be forged from the client.
alter table app_user_roles add column if not exists role_organization_id uuid;
update app_user_roles ur
   set role_organization_id = ro.organization_id
  from app_roles ro
 where ro.id = ur.role_id
   and ur.role_organization_id is distinct from ro.organization_id;

create or replace function app_user_roles_bind_role_org()
  returns trigger
  language plpgsql
as $$
declare
  v_role_org uuid;
  v_found boolean;
begin
  select true, ro.organization_id into v_found, v_role_org
    from app_roles ro
   where ro.id = new.role_id;
  if v_found is not true then
    -- Unknown role: leave the mirror NULL and let the role_id FK report it.
    new.role_organization_id := null;
    return new;
  end if;
  if v_role_org is not null and v_role_org <> new.organization_id then
    raise exception 'app_user_roles: role % belongs to organization % and cannot be assigned inside organization %',
      new.role_id, v_role_org, new.organization_id
      using errcode = 'check_violation',
            constraint = 'app_user_roles_role_organization_id_check',
            hint = 'Assign a role owned by the membership''s organization, or a global role (organization_id IS NULL).';
  end if;
  new.role_organization_id := v_role_org;
  return new;
end;
$$;

drop trigger if exists trg_app_user_roles_bind_role_org on app_user_roles;
create trigger trg_app_user_roles_bind_role_org
  before insert or update of role_id, organization_id, role_organization_id on app_user_roles
  for each row
  execute function app_user_roles_bind_role_org();

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_user_roles'::regclass and conname = 'app_user_roles_role_organization_id_check') then
    alter table app_user_roles add constraint app_user_roles_role_organization_id_check
      check (role_organization_id is null or role_organization_id = organization_id) not valid;
  end if;
end $$;
alter table app_user_roles validate constraint app_user_roles_role_organization_id_check;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'app_user_roles'::regclass and conname = 'app_user_roles_role_org_fkey') then
    -- NO ACTION (like the original role_id FK): deleting an assigned role is
    -- refused by the route's in-use guard, and re-homing a role that is
    -- assigned somewhere is refused here.
    alter table app_user_roles add constraint app_user_roles_role_org_fkey
      foreign key (role_id, role_organization_id) references app_roles (id, organization_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. #83 — audit table: owner/runtime role split + SECURITY DEFINER retention
-- ---------------------------------------------------------------------------
-- 5a. Runtime role. Named after the schema (`<DB_SCHEMA>_runtime`, so
--     `auth_runtime` by default) because role names are cluster-wide and one
--     cluster may host several schemas of this kit. Created NOLOGIN with no
--     password: the operator enables it deliberately (see
--     docs/deployment.md, "Least-privilege runtime role"). If the migrating
--     role lacks CREATEROLE (some managed providers), the block reports the
--     manual steps as a NOTICE and the rest of this file still applies —
--     the role split is then an operator step, not a migration failure.
do $$
declare
  v_schema text := current_schema();
  v_role   text := current_schema() || '_runtime';
begin
  if not exists (select 1 from pg_roles where rolname = v_role) then
    begin
      execute format('create role %I nologin', v_role);
      raise notice '%', format(
        '[0005] created runtime role %I (NOLOGIN, no password). Enable it deliberately with: alter role %I login password ''<secret>''; then point the application DATABASE_URL at it (docs/deployment.md, "Least-privilege runtime role").',
        v_role, v_role);
    exception when insufficient_privilege then
      raise notice '%', format(
        '[0005] could not create runtime role %I (the migrating role lacks CREATEROLE); the rest of this migration still applies. Manual steps, as a role that can create roles: create role %I nologin; then re-run pnpm db:app:migrate (the grant block is idempotent) — or grant by hand: grant usage on schema %I to %I; grant select, insert, update, delete on all tables in schema %I to %I; alter default privileges in schema %I grant select, insert, update, delete on tables to %I; revoke update, delete, truncate on %I.app_audit_events from %I; grant execute on function %I.app_audit_events_prune(integer, integer) to %I.',
        v_role, v_role, v_schema, v_role, v_schema, v_role, v_schema, v_role, v_schema, v_role, v_schema, v_role);
    end;
  end if;
end $$;

-- 5b. Retention as a SECURITY DEFINER function owned by the migrating (owner)
--     role. Deletes ONE bounded batch of rows older than p_days and returns
--     the count; the worker (src/lib/retention.server.ts) loops until a
--     short batch. `search_path from current` pins the schema at creation
--     time (the runner connects with DB_SCHEMA first), the standard
--     SECURITY DEFINER hygiene. The `app.audit_retention` marker is set
--     transaction-locally INSIDE the function only — see the trigger below
--     for why it is no longer sufficient on its own.
--
--     OWNER-CONTROLLED WINDOW (review #83, must-fix): the function is the
--     runtime role's ONLY way to delete audit rows, so the caller's p_days
--     must not be the whole policy — a stolen runtime credential calling
--     prune(1, …) in a loop would otherwise erase everything older than a
--     day. The window is therefore clamped to a FLOOR baked into this
--     owner-owned function body (`c_floor_days`; the runtime role has no
--     CREATE on the schema and cannot replace it), and the batch is capped
--     so a single call stays bounded. Callers asking for less than the floor
--     get the floor (the worker mirrors the clamp client-side and logs it);
--     an operator who needs a shorter window changes the constant in a NEW
--     migration, as the owner — never through the application credential.
--     Keep `AUDIT_RETENTION_FLOOR_DAYS` in src/lib/retention.server.ts and
--     the docs (configuration.md, admin-manager §12.1) equal to this value.
create or replace function app_audit_events_prune(p_days integer, p_batch integer)
  returns integer
  language plpgsql
  security definer
  set search_path from current
as $$
declare
  c_floor_days constant integer := 30;
  c_max_batch  constant integer := 10000;
  v_deleted integer;
begin
  if p_days is null or p_days <= 0 or p_batch is null or p_batch <= 0 then
    return 0;
  end if;
  p_days  := greatest(p_days, c_floor_days);
  p_batch := least(p_batch, c_max_batch);
  perform set_config('app.audit_retention', 'on', true);
  delete from app_audit_events
   where ctid in (
     select ctid from app_audit_events
      where created_at < now() - make_interval(days => p_days)
      limit p_batch
   );
  get diagnostics v_deleted = row_count;
  perform set_config('app.audit_retention', 'off', true);
  return v_deleted;
end;
$$;
revoke all on function app_audit_events_prune(integer, integer) from public;

-- 5c. Append-only trigger. A DELETE is permitted only when BOTH hold:
--       (1) the EFFECTIVE role (`current_user`) is the table's owner — true
--           inside app_audit_events_prune (SECURITY DEFINER, owner-owned)
--           whoever called it, and never true for the runtime role; and
--       (2) the transaction-local marker the prune function sets is on.
--     Previously (2) alone was the escape hatch, and any session could SET
--     it. Now the runtime role has no DELETE privilege at all (5d), and even
--     a role that somehow gained one fails (1). The owner can of course still
--     disable the trigger — the guarantee is against the application's
--     credentials, not against the schema owner. `session_user` and
--     `current_user` are reported in the error so a rejected attempt names
--     the login role that made it.
--     The org-deletion tombstone UPDATE (0001, DB-1) is unchanged.
create or replace function app_audit_events_block_mutation()
  returns trigger
  language plpgsql
as $$
declare
  v_owner name;
begin
  if tg_op = 'DELETE' then
    select pg_get_userbyid(c.relowner) into v_owner
      from pg_class c
     where c.oid = tg_relid;
    if current_user = v_owner
       and current_setting('app.audit_retention', true) = 'on' then
      return old;
    end if;
  end if;
  -- DB-1: an org DELETE fires `update app_audit_events set organization_id = null`
  -- via the ON DELETE SET NULL cascade. Permit ONLY that exact tombstone —
  -- organization_id non-null -> null with EVERY other column unchanged.
  if tg_op = 'UPDATE'
     and old.organization_id is not null
     and new.organization_id is null
     and (to_jsonb(new) - 'organization_id') = (to_jsonb(old) - 'organization_id') then
    return new;
  end if;
  raise exception 'app_audit_events is append-only: % is not permitted (session_user=%, current_user=%)',
    tg_op, session_user, current_user
    using errcode = 'check_violation',
          hint = 'Audit rows are immutable; aged rows are removed only by app_audit_events_prune() (the retention job), which runs as the table owner.';
end;
$$;

drop trigger if exists trg_app_audit_events_append_only on app_audit_events;
create trigger trg_app_audit_events_append_only
  before update or delete on app_audit_events
  for each row
  execute function app_audit_events_block_mutation();

-- 5d. Grants for the runtime role (skipped, with the notice above, when the
--     role could not be created). Whole-schema DML so the application works
--     unchanged, MINUS update/delete/truncate on the audit table, PLUS the
--     prune function. Default privileges cover tables a LATER migration
--     creates as the same owner, so the split does not rot.
do $$
declare
  v_schema text := current_schema();
  v_role   text := current_schema() || '_runtime';
begin
  if not exists (select 1 from pg_roles where rolname = v_role) then
    return;
  end if;
  execute format('grant usage on schema %I to %I', v_schema, v_role);
  execute format('grant select, insert, update, delete on all tables in schema %I to %I', v_schema, v_role);
  execute format('grant usage, select on all sequences in schema %I to %I', v_schema, v_role);
  execute format('alter default privileges in schema %I grant select, insert, update, delete on tables to %I', v_schema, v_role);
  execute format('alter default privileges in schema %I grant usage, select on sequences to %I', v_schema, v_role);
  execute format('revoke update, delete, truncate on %I.app_audit_events from %I', v_schema, v_role);
  execute format('grant execute on function %I.app_audit_events_prune(integer, integer) to %I', v_schema, v_role);
end $$;
-- ===== END folded 0005-integrity-constraints.sql =====

-- ===== BEGIN folded 0006-rate-limit-buckets.sql =====
-- 0006-rate-limit-buckets.sql
--
-- Shared token-bucket storage for the PRE-AUTH rate-limit floors (source
-- review 2026-09-04, #98). The in-process limiter in
-- `src/lib/http/rate-limit.server.ts` keeps its budget in one Node process's
-- memory, so on Vercel — one lambda per concurrent invocation — the
-- "deployment-wide" floors on the token endpoint, MCP registration, the CSP
-- report sink and invitation acceptance were really per-lambda floors, and a
-- distributed run that fanned out across invocations multiplied every budget
-- by the instance count. This table is the cluster-wide store those floors
-- now consume from (`src/lib/http/rate-limit-shared.server.ts`).
--
-- One row per bucket key: the token balance and the instant it was last
-- brought up to date. Capacity and refill rate are NOT stored — they are
-- properties of the call site, passed with every consume, so the same key can
-- be re-budgeted without a data migration (the in-memory limiter has the same
-- "most recent caller wins" rule). Refill-and-consume is a single
-- `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` statement: the refill is
-- computed from `updated_at` in SQL, the row is updated only when a token is
-- available (the `WHERE` gates the update, so a denied request changes
-- nothing and returns no row), and Postgres evaluates that condition against
-- the row's LATEST version under the conflict lock — N concurrent consumers of
-- one key therefore serialise and exactly the budgeted number succeed.
--
-- `tokens >= 0` holds by construction (an update only fires when the refilled
-- balance is at least 1 and then subtracts exactly 1); the CHECK pins it.
-- No index on `updated_at`: the table is bounded to keys touched within the
-- prune window (an hour), the opportunistic prune is a low-frequency seq scan
-- of that small set, and an index on the column every consume rewrites would
-- defeat HOT updates and bloat the hot rows.
--
-- The `<schema>_runtime` role (0005) needs full DML here; it receives it
-- through the default privileges 0005 declared for tables created later in
-- the schema by the migrating role — no explicit grant is required.
--
-- Idempotent (`if not exists`); additive; safe against a live database.
--
-- LANDING ORDER: the shared limiter treats a missing table as a backend error
-- and falls back to the in-process limiter with a structured warning (the
-- pre-0006 behaviour, made visible), so a build that runs ahead of this file
-- degrades rather than breaks. Apply it with `pnpm db:app:migrate` as usual;
-- until it is applied, the floors stay per-instance and `/api/metrics` shows
-- `devresponsekit_rate_limit_shared_fallbacks_total` climbing.

create table if not exists app_rate_limits (
  key         text primary key,
  tokens      numeric not null check (tokens >= 0),
  updated_at  timestamptz not null
);
-- ===== END folded 0006-rate-limit-buckets.sql =====

-- ===== BEGIN folded 0007-uniqueness-search-indexes-token-scrub.sql =====
-- 0007-uniqueness-search-indexes-token-scrub.sql
--
-- Remaining schema work from the 2026-09-22 full review's Low findings:
--
--   F-97  UNIQUE index on the GLOBAL role keys. `unique (organization_id, key)`
--         (0001) treats NULLs as distinct, so it never bounded the global
--         roles (organization_id IS NULL): POST /roles checked a global key
--         with a SELECT and then inserted, and two superadmins creating the
--         same global key at the same moment both committed, which made every
--         key-based lookup of it ambiguous. The route already maps a 23505 on
--         insert to 409 `key_taken`, so with this index the race loser gets
--         the same answer as a sequential duplicate.
--   M-02  UNIQUE index on the default-organization flag (the F-40 residual).
--         Every writer of `is_default` already serialises on an advisory lock
--         (`DEFAULT_ORGANIZATION_LOCK_SQL`) and moves the flag clear-then-set,
--         so the application never produces two defaults. The index makes
--         "exactly one default" hold for a direct database edit or a future
--         writer that forgets the lock too. The lock stays: an index refuses a
--         second default, it does not serialise two moves.
--   F-93  Trigram indexes for the search arms that had none. The audit
--         explorer's `q` is `event_type ILIKE … OR email ILIKE … OR reason
--         ILIKE …`, and the outbox grid's is `to_email … OR subject … OR
--         template_key …`. 0001 indexed every arm except `event_type` and
--         `template_key`, on the reasoning that low-cardinality columns gain
--         nothing from a trigram index. That holds for a column searched on
--         its own, not for one arm of an OR: Postgres can serve an OR from
--         indexes only as a BitmapOr of EVERY arm, so the one unindexed arm
--         turned each search of these two unbounded tables (every sign-in and
--         token mint writes an audit row) into a sequential scan and left the
--         other trigram indexes unused. The same predicates back the CSV
--         export of the audit log. A btree cannot serve a leading-wildcard
--         `'%q%'` ILIKE, so a trigram GIN index (pg_trgm is installed by 0001,
--         in `public`) is the only index that serves the arm as written; the
--         list queries themselves are unchanged.
--   F-150 Scrub the OAuth provider tokens Better Auth stored. The app uses
--         social sign-in for identity only and never reads `accessToken`,
--         `refreshToken` or `idToken`, yet each sign-in wrote them in
--         plaintext, and they stayed after a soft delete: a GitHub OAuth token
--         does not expire, and the ID tokens carry name, email and tenant
--         claims. From this release `databaseHooks.account` in
--         `src/lib/auth.ts` stores none of them; this statement clears the
--         ones already stored. The expiry columns describe those tokens and
--         are cleared with them.
--
-- PREFLIGHT: the two unique indexes would fail on existing duplicates with a
-- bare 23505, so the block below lists every offender first and raises (the
-- runner applies this file in one transaction, so nothing is changed). It
-- never deletes or edits data: an operator decides which global role or which
-- default flag goes, then re-runs `pnpm db:app:migrate`.
--
-- Idempotent (`if not exists`, and the scrub only touches rows that still hold
-- a token), additive, and safe to apply before the code that ships with it:
-- the previous build maps the global-key 23505 to 409 `key_taken` already,
-- moves the default flag clear-then-set, and does not read the tokens.
--
-- LOCKS: the runner wraps each file in a transaction, so CREATE INDEX
-- CONCURRENTLY is not available here. Each CREATE INDEX takes a SHARE lock on
-- its table until the file commits, which blocks writes (not reads) to it for
-- the build time. `app_roles` and `app_organizations` are small. On a large
-- `app_audit_events` or `app_outbox`, build those two indexes by hand first,
-- outside a transaction, with the SAME names:
--
--   create index concurrently if not exists idx_app_audit_events_event_type_trgm
--     on auth.app_audit_events using gin (event_type gin_trgm_ops);
--   create index concurrently if not exists idx_app_outbox_template_key_trgm
--     on auth.app_outbox using gin (template_key gin_trgm_ops);
--
-- (`auth` = DB_SCHEMA.) Check `pg_index.indisvalid` afterwards: a failed
-- concurrent build leaves an INVALID index under that name, which the
-- statements below would then skip, so drop it and build again. The runbook,
-- with verification and rollback, is docs/deployment.md, "Migration 0007".
--
-- LANDING ORDER: this id is in `REQUIRED_CORE_MIGRATIONS`, so once the build
-- that ships it is live `GET /api/health/ready` answers 503 `schema_behind`
-- until the ledger records it. Apply it to production BEFORE merging.

-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT: abort with the offender list if either unique index would
--    fail. Runs first so nothing is changed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_offenders text[] := '{}';
  r record;
begin
  for r in
    -- F-97: a global role key held by two or more global roles.
    select 'app_roles' as tbl, 'key (global)' as col, key as val, count(*) as n
    from app_roles
    where organization_id is null
    group by key
    having count(*) > 1
    union all
    -- M-02: more than one organization flagged default, oldest first (the
    -- one sign-up routing resolves to, `getDefaultOrganization`).
    select 'app_organizations', 'is_default',
           string_agg(slug || ' ' || id::text, ', ' order by created_at, id), count(*)
    from app_organizations
    where is_default
    having count(*) > 1
  loop
    v_offenders := v_offenders || format('%s.%s = %L (%s rows)', r.tbl, r.col, r.val, r.n);
  end loop;

  if array_length(v_offenders, 1) > 0 then
    raise exception '[0007] refusing to apply: % row group(s) would violate a unique index this migration adds. Fix the data, then re-run. Offenders (table.column = value (count)): %',
      array_length(v_offenders, 1), array_to_string(v_offenders, '; ')
      using errcode = 'unique_violation',
            hint = 'Nothing was changed. A duplicated global role key: delete the unused duplicate (Administrator -> Roles) or re-key it by SQL. Several default organizations: sign-ups go to the OLDEST (listed first); open each other one -> Settings and untick "Set as default organization", which clears an extra flag. Then re-run pnpm db:app:migrate.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. F-97: one global role per key
-- ---------------------------------------------------------------------------
-- Org-scoped keys stay bounded by 0001's `unique (organization_id, key)`.
create unique index if not exists idx_app_roles_global_key
  on app_roles (key)
  where organization_id is null;

-- ---------------------------------------------------------------------------
-- 2. M-02: at most one default organization
-- ---------------------------------------------------------------------------
-- Partial, so any number of orgs may carry `false`. Nothing maps this index's
-- 23505: every application writer holds the default-flag lock and clears the
-- old default before setting the new one, so only a direct edit can trip it.
create unique index if not exists idx_app_organizations_single_default
  on app_organizations (is_default)
  where is_default;

-- ---------------------------------------------------------------------------
-- 3. F-93: the missing arms of the audit and outbox search ORs
-- ---------------------------------------------------------------------------
create index if not exists idx_app_audit_events_event_type_trgm
  on app_audit_events using gin (event_type gin_trgm_ops);
create index if not exists idx_app_outbox_template_key_trgm
  on app_outbox using gin (template_key gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 4. F-150: clear the stored OAuth provider tokens
-- ---------------------------------------------------------------------------
-- Better Auth's `account` table lives in the same schema (DB_SCHEMA) but is
-- created by `pnpm db:auth:migrate`, which may not have run yet on a fresh
-- database, so the statement is guarded and dynamic, as 0001 treats "user".
-- Credential (email/password) rows never hold a token and are not touched.
do $$
declare
  v_scrubbed bigint;
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = current_schema()
      and table_name = 'account'
  ) then
    raise notice '[0007] Better Auth "account" table not found in schema %; no provider tokens to scrub.', current_schema();
    return;
  end if;

  execute $sql$
    update "account"
       set "accessToken" = null,
           "refreshToken" = null,
           "idToken" = null,
           "accessTokenExpiresAt" = null,
           "refreshTokenExpiresAt" = null
     where "accessToken" is not null
        or "refreshToken" is not null
        or "idToken" is not null
  $sql$;
  get diagnostics v_scrubbed = row_count;
  raise notice '[0007] cleared stored provider tokens on % account row(s).', v_scrubbed;
end $$;
-- ===== END folded 0007-uniqueness-search-indexes-token-scrub.sql =====

-- ===== BEGIN folded 0008-user-data-export-erasure.sql =====
-- 0008-user-data-export-erasure.sql
--
-- F-151 (2026-09-22 full review, raw finding #205): a data-subject EXPORT and
-- an ERASURE path. Until now the operator could only soft-delete. The person's
-- address and name stayed on `app_users` and on Better Auth's `user` row, their
-- IP address and user agent on every audit row of their own requests, their
-- address on invitations, outbox rows and audit rows, and their sessions and
-- sign-in credentials in Better Auth's tables. A hard delete is not possible
-- either: `app_audit_events.app_user_id` references `app_users` with no ON
-- DELETE action, and the append-only trigger rejects every UPDATE, so the only
-- way to remove the PII was to connect as the schema owner, disable the trigger
-- and hand-cascade a dozen tables, which defeats the tamper evidence the audit
-- log exists for. This file adds:
--
--   1. the `admin.users.export` permission (`ADMIN_PERMISSION_CATALOG`) for
--      the administrator export of one user's data,
--      `GET /api/administrator/users/[id]/export`. The person's own export,
--      `GET /api/account/export`, needs no permission. Superadmins hold the
--      new key through the `superuser` marker, and `pnpm db:seed` gives it to
--      the seeded `admin.platform` role with the rest of the catalog; no role
--      gets it here, so until an administrator grants it (Administrator ->
--      Roles) or the seed re-runs, only superadmins can export another user.
--   2. a narrow exemption in the audit table's append-only trigger: an UPDATE
--      that changes ONLY `email`, `ip_address`, `user_agent` and the `email`
--      key of `metadata`, where the IP and user agent may only be cleared and
--      each address may only become an erasure pseudonym (a metadata `email`
--      only where the key was already there), is let through when the
--      effective role is the table owner AND the transaction-local
--      `app.audit_pseudonymise` marker is on. That is the retention DELETE's
--      two-part rule (0005, section 5c) applied to an UPDATE. Every other
--      UPDATE and DELETE is still rejected, the marker alone does nothing for
--      a non-owner, and the runtime role has no UPDATE privilege on the table
--      at all. The row count, ids, event types, outcomes, actors, subjects,
--      organizations, reasons, timestamps and every other metadata key of the
--      trail are unchanged; only the personal data in it is replaced.
--   3. `app_users_pseudonymise(app_user_id)`: a SECURITY DEFINER function owned
--      by the migrating (owner) role and executable by `<schema>_runtime`, like
--      `app_audit_events_prune`. For an account that is already soft-deleted
--      (`status = 'deactivated'`; anything else raises 55000) it replaces the
--      person's data in place, so every foreign key still resolves and the
--      audit trail keeps its shape:
--        - `app_users`: `primary_email` -> `erased+<id>@erased.invalid`,
--          `display_name` -> NULL;
--        - Better Auth `user`: `email` -> the same pseudonym, `name` ->
--          'Erased user', `image` -> NULL;
--        - Better Auth `session` and `account` rows: deleted, which ends every
--          session and removes the password hash and the social-login links;
--          `verification` rows naming the user or an address of theirs:
--          deleted;
--        - `app_user_locale_preferences`: deleted (the time zone locates them);
--        - `app_api_keys`: `last_used_ip` cleared, and any key still active
--          revoked; `app_oauth_clients` still active: revoked. The admin route
--          has revoked them already (audited, through the issuance fence), so
--          this is the backstop for a direct call;
--        - `app_organization_invitations` addressed to them: the address
--          pseudonymised, a pending one revoked;
--        - `app_outbox` rows addressed to them: the address pseudonymised,
--          subject, bodies, variables and delivery payload blanked, a pending
--          row failed (`recipient_erased`) so it is never sent;
--        - `app_audit_events`: the address pseudonymised wherever it names
--          them, in the `email` column and in the `email` key of `metadata`
--          (where `admin.organization.invitation_created` keeps the invitee's
--          address: auditOrgAction writes no email column and no subject id),
--          and the IP address and user agent cleared on the rows of their OWN
--          requests (actor = them, or no actor and the row names them). Rows
--          where an administrator acted on them keep the administrator's IP
--          and user agent: those are the administrator's, and they are the
--          accountability record.
--      "Their addresses" are the account's `primary_email`, its Better Auth
--      email and the address of every invitation it accepted, compared
--      lowercased. The pseudonym is derived from the account's own id, so a
--      second call finds nothing left to change and returns zero counts
--      (`alreadyErased: true`): the function is idempotent. It returns a jsonb
--      object with the pseudonym and a count per step, which the admin route
--      records on its `admin.user.erased` audit row.
--
--      Every call that gets past the checks also inserts its OWN audit row,
--      `db.user.pseudonymised` (the account, the pseudonym, the counts, the
--      database login and the SET ROLE in effect). The runtime role executes
--      the function and can itself deactivate an account (0005 gives it
--      UPDATE on `app_users`), so a stolen runtime credential could otherwise
--      pseudonymise anyone's rows, recent ones included, and leave no trace
--      outside the admin route. It still cannot delete a row or change any
--      other column, and the record of the call is append-only like the rest.
--
--      Deliberately NOT changed: free text an administrator typed (status,
--      deactivation and ban reasons, audit `reason`), audit `metadata` other
--      than its `email` key (the rest holds ids and codes), memberships, role
--      and group assignments (they carry no personal data and keep the
--      history readable), Better Auth's ban flags (the account stays banned),
--      and mail sent to OTHER people that names them: an invitation's
--      `inviterName` (their display name, or their address when they had
--      none) stays in each invitee's `app_outbox` row until outbox retention
--      removes it (`OUTBOX_RETENTION_DAYS`, sent and failed rows).
--
-- Additive and idempotent: an INSERT … ON CONFLICT DO NOTHING and two CREATE OR
-- REPLACE FUNCTION statements, which take no table lock, so it is safe to apply
-- to a live database and before the code that ships with it: the previous
-- build never calls the function and never sets the marker, and the trigger
-- function keeps its two existing exemptions verbatim. No PREFLIGHT can fail
-- on data. The block at the end only warns (NOTICE) when the migrating role
-- cannot write Better Auth's tables, because the function runs with that
-- role's privileges and an erasure would then fail at runtime.
--
-- LANDING ORDER: this id is in `REQUIRED_CORE_MIGRATIONS` (the erase route
-- calls the function), so once the build that ships it is live
-- `GET /api/health/ready` answers 503 `schema_behind` until the ledger records
-- it. Apply it to production BEFORE merging. The runbook, with verification
-- and rollback, is docs/deployment.md, "Migration 0008"; the operator
-- procedure for an access or erasure request is docs/admin-manager.md,
-- "Data export and erasure (F-151)".

-- ---------------------------------------------------------------------------
-- 1. The administrator export permission
-- ---------------------------------------------------------------------------
-- Key and description MUST match `ADMIN_PERMISSION_CATALOG` verbatim
-- (tests/unit/migration-permission-catalog-sync.test.ts).
insert into app_permissions (key, description) values
  ('admin.users.export', 'Export a user''s personal data')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Append-only trigger: the pseudonymisation exemption
-- ---------------------------------------------------------------------------
-- Replaces the function from 0005 (section 5c). The DELETE rule and the DB-1
-- org tombstone are copied unchanged; the third branch is new. It checks the owner half first
-- only when the marker is on, so an ordinary rejected UPDATE costs no catalog
-- read. `jsonb - text[]` drops the four columns the exemption may change, so
-- ANY other column differing (the actor, the reason, the timestamp, …) fails
-- the equality and falls through to the exception; `metadata` is then held to
-- the same rule minus its `email` key, which may only go from present to a
-- pseudonym.
create or replace function app_audit_events_block_mutation()
  returns trigger
  language plpgsql
as $$
declare
  v_owner name;
begin
  if tg_op = 'DELETE' then
    select pg_get_userbyid(c.relowner) into v_owner
      from pg_class c
     where c.oid = tg_relid;
    if current_user = v_owner
       and current_setting('app.audit_retention', true) = 'on' then
      return old;
    end if;
  end if;
  -- DB-1: an org DELETE fires `update app_audit_events set organization_id = null`
  -- via the ON DELETE SET NULL cascade. Permit ONLY that exact tombstone —
  -- organization_id non-null -> null with EVERY other column unchanged.
  if tg_op = 'UPDATE'
     and old.organization_id is not null
     and new.organization_id is null
     and (to_jsonb(new) - 'organization_id') = (to_jsonb(old) - 'organization_id') then
    return new;
  end if;
  -- F-151: `app_users_pseudonymise` (SECURITY DEFINER, owner-owned) sets the
  -- transaction-local marker. It may clear the IP address and user agent and
  -- replace an address (the email column, an existing `metadata.email`) with
  -- an erasure pseudonym, and change nothing else.
  if tg_op = 'UPDATE'
     and current_setting('app.audit_pseudonymise', true) = 'on' then
    select pg_get_userbyid(c.relowner) into v_owner
      from pg_class c
     where c.oid = tg_relid;
    if current_user = v_owner
       and (to_jsonb(new) - array['email', 'ip_address', 'user_agent', 'metadata'])
           = (to_jsonb(old) - array['email', 'ip_address', 'user_agent', 'metadata'])
       and (new.ip_address is null or new.ip_address is not distinct from old.ip_address)
       and (new.user_agent is null or new.user_agent is not distinct from old.user_agent)
       and (new.email is not distinct from old.email
            or new.email ~ '^erased\+[0-9a-f-]{36}@erased\.invalid$')
       and (new.metadata = old.metadata
            or (old.metadata ? 'email'
                and (new.metadata - 'email') = (old.metadata - 'email')
                and jsonb_typeof(new.metadata -> 'email') = 'string'
                and (new.metadata ->> 'email') ~ '^erased\+[0-9a-f-]{36}@erased\.invalid$')) then
      return new;
    end if;
  end if;
  raise exception 'app_audit_events is append-only: % is not permitted (session_user=%, current_user=%)',
    tg_op, session_user, current_user
    using errcode = 'check_violation',
          hint = 'Audit rows are immutable; aged rows are removed only by app_audit_events_prune() (the retention job), and an erased user''s personal data is replaced only by app_users_pseudonymise(); both run as the table owner.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The erasure primitive
-- ---------------------------------------------------------------------------
-- `search_path from current` pins the schema at creation time (the runner
-- connects with DB_SCHEMA first), the standard SECURITY DEFINER hygiene, as
-- for app_audit_events_prune. Better Auth's tables live in the same schema;
-- plpgsql resolves them when the function first runs, so creating it before
-- `pnpm db:auth:migrate` has run is fine.
--
-- The pseudonym `erased+<app_users.id>@erased.invalid` is mirrored by
-- `erasedEmailFor` in src/lib/admin/erased-user.ts, which the console uses to
-- tell an erased account apart (restore refuses one with 409 `user_erased`).
-- `.invalid` is reserved (RFC 2606), so nothing can ever be delivered to it.
create or replace function app_users_pseudonymise(p_app_user_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path from current
as $$
declare
  c_erased_name constant text := 'Erased user';
  c_pseudonym_re constant text := '^erased\+[0-9a-f-]{36}@erased\.invalid$';
  v_user record;
  v_pseudonym text;
  v_already boolean;
  v_emails text[];
  n_sessions bigint;
  n_accounts bigint;
  n_verifications bigint;
  n_preferences bigint;
  n_api_keys bigint;
  n_oauth_clients bigint;
  n_invitations bigint;
  n_outbox bigint;
  n_audit bigint;
  v_counts jsonb;
begin
  if p_app_user_id is null then
    raise exception '[erasure] an app user id is required'
      using errcode = 'null_value_not_allowed';
  end if;

  -- The row lock serialises two erasures, and an erasure against a restore
  -- (which updates this row), so the status read below stays true.
  select id, better_auth_user_id, primary_email, status
    into v_user
    from app_users
   where id = p_app_user_id
   for update;
  if not found then
    raise exception '[erasure] no app user %', p_app_user_id
      using errcode = 'no_data_found';
  end if;
  if v_user.status <> 'deactivated' then
    raise exception '[erasure] app user % is %, not deactivated: soft-delete the account first',
      p_app_user_id, v_user.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_pseudonym := 'erased+' || v_user.id::text || '@erased.invalid';
  v_already := v_user.primary_email = v_pseudonym;

  -- Every address the account is known by, lowercased. A pseudonym is never
  -- one (after a first run the account's own addresses ARE pseudonyms, which
  -- is what makes a second run find nothing).
  select coalesce(array_agg(distinct s.e), '{}')
    into v_emails
    from (
      select lower(v_user.primary_email) as e
      union all
      select lower(u.email) from "user" u where u.id = v_user.better_auth_user_id
      union all
      select lower(i.email)
        from app_organization_invitations i
       where i.accepted_app_user_id = v_user.id
    ) s
   where s.e is not null
     and s.e !~ c_pseudonym_re;

  -- Better Auth: end every session, remove every credential, drop pending
  -- reset tokens (value = user id) and anything keyed by an address.
  delete from "session" where "userId" = v_user.better_auth_user_id;
  get diagnostics n_sessions = row_count;
  delete from "account" where "userId" = v_user.better_auth_user_id;
  get diagnostics n_accounts = row_count;
  delete from "verification"
   where value = v_user.better_auth_user_id
      or lower(identifier) = any(v_emails);
  get diagnostics n_verifications = row_count;
  update "user"
     set email = v_pseudonym,
         name = c_erased_name,
         image = null,
         "updatedAt" = now()
   where id = v_user.better_auth_user_id
     and (email is distinct from v_pseudonym
          or name is distinct from c_erased_name
          or image is not null);

  update app_users
     set primary_email = v_pseudonym,
         display_name = null,
         updated_at = now()
   where id = v_user.id
     and (primary_email is distinct from v_pseudonym or display_name is not null);

  delete from app_user_locale_preferences where app_user_id = v_user.id;
  get diagnostics n_preferences = row_count;

  -- Backstop revocation (the admin route revoked them first, audited).
  update app_api_keys
     set last_used_ip = null,
         status = 'revoked',
         revoked_at = coalesce(revoked_at, now()),
         revoked_reason = coalesce(revoked_reason, 'owner_deleted')
   where app_user_id = v_user.id
     and (status = 'active' or last_used_ip is not null);
  get diagnostics n_api_keys = row_count;
  update app_oauth_clients
     set status = 'revoked',
         revoked_at = coalesce(revoked_at, now())
   where app_user_id = v_user.id
     and status = 'active';
  get diagnostics n_oauth_clients = row_count;

  update app_organization_invitations
     set email = v_pseudonym,
         status = case when status = 'pending' then 'revoked' else status end,
         revoked_at = case when status = 'pending' then now() else revoked_at end,
         updated_at = now()
   where lower(email) = any(v_emails);
  get diagnostics n_invitations = row_count;

  -- `related_better_auth_user_id` marks the user's own verification and reset
  -- mail (src/lib/auth.ts), which may have gone to an address they no longer
  -- hold; `to_email <> pseudonym` keeps a second run from matching it again.
  update app_outbox
     set to_email = v_pseudonym,
         subject = '[erased]',
         body_html = '',
         body_text = null,
         variables = '{}'::jsonb,
         delivery_payload = null,
         error = case when status = 'pending' then 'recipient_erased' else error end,
         next_attempt_at = case when status = 'pending' then null else next_attempt_at end,
         status = case when status = 'pending' then 'failed' else status end
   where (lower(to_email) = any(v_emails)
          or related_better_auth_user_id = v_user.better_auth_user_id)
     and to_email <> v_pseudonym;
  get diagnostics n_outbox = row_count;

  -- The audit trail, through the trigger exemption above. A row names the
  -- person by its `email` column or by the `email` key of its metadata (the
  -- invitation an administrator sent them). An IP address and a user agent
  -- are the person's when the request was theirs: they are the actor, or no
  -- actor is recorded and the row names them.
  perform set_config('app.audit_pseudonymise', 'on', true);
  update app_audit_events e
     set email = case when lower(e.email) = any(v_emails) then v_pseudonym else e.email end,
         metadata = case
           when lower(e.metadata ->> 'email') = any(v_emails)
           then jsonb_set(e.metadata, '{email}', to_jsonb(v_pseudonym))
           else e.metadata end,
         ip_address = case
           when e.actor_better_auth_user_id = v_user.better_auth_user_id
             or (e.actor_better_auth_user_id is null
                 and (e.app_user_id = v_user.id
                      or lower(e.email) = any(v_emails)
                      or lower(e.metadata ->> 'email') = any(v_emails)))
           then null else e.ip_address end,
         user_agent = case
           when e.actor_better_auth_user_id = v_user.better_auth_user_id
             or (e.actor_better_auth_user_id is null
                 and (e.app_user_id = v_user.id
                      or lower(e.email) = any(v_emails)
                      or lower(e.metadata ->> 'email') = any(v_emails)))
           then null else e.user_agent end
   where lower(e.email) = any(v_emails)
      or lower(e.metadata ->> 'email') = any(v_emails)
      or ((e.ip_address is not null or e.user_agent is not null)
          and (e.actor_better_auth_user_id = v_user.better_auth_user_id
               or (e.actor_better_auth_user_id is null and e.app_user_id = v_user.id)));
  get diagnostics n_audit = row_count;
  perform set_config('app.audit_pseudonymise', 'off', true);

  v_counts := jsonb_build_object(
    'sessions', n_sessions,
    'accounts', n_accounts,
    'verifications', n_verifications,
    'localePreferences', n_preferences,
    'apiKeys', n_api_keys,
    'oauthClients', n_oauth_clients,
    'invitations', n_invitations,
    'outbox', n_outbox,
    'auditEvents', n_audit
  );

  -- Every call is on record, whoever made it: the admin route's
  -- `admin.user.erased` row names the administrator, but the runtime role can
  -- call this directly (header). `session_user` is the database login and
  -- `role` the SET ROLE in effect ('none' when none); neither changes inside
  -- a SECURITY DEFINER function. Under the pseudonym, like the route's row.
  insert into app_audit_events (event_type, outcome, app_user_id, email, metadata)
  values (
    'db.user.pseudonymised',
    'success',
    v_user.id,
    v_pseudonym,
    jsonb_build_object(
      'alreadyErased', v_already,
      'counts', v_counts,
      'sessionUser', session_user::text,
      'role', current_setting('role')
    )
  );

  return jsonb_build_object('pseudonym', v_pseudonym, 'alreadyErased', v_already) || v_counts;
end;
$$;
revoke all on function app_users_pseudonymise(uuid) from public;

-- Grant to the runtime role when 0005 could create it (the same guard as
-- 0005 section 5d: skipped silently when the role is absent, since 0005 already
-- printed the manual steps for that case).
do $$
declare
  v_role text := current_schema() || '_runtime';
begin
  if exists (select 1 from pg_roles where rolname = v_role) then
    execute format('grant execute on function %I.app_users_pseudonymise(uuid) to %I',
      current_schema(), v_role);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Warn when the function could not write Better Auth's tables
-- ---------------------------------------------------------------------------
-- The function runs with the migrating role's privileges. Better Auth's tables
-- are created by `pnpm db:auth:migrate`, normally as the same role; on a
-- database where another role owns them, an erasure would fail with 42501.
-- Absent tables (a fresh database before db:auth:migrate) are not a problem.
do $$
declare
  v_missing text[] := '{}';
  v_table text;
begin
  foreach v_table in array array['user', 'session', 'account', 'verification'] loop
    if to_regclass(format('%I.%I', current_schema(), v_table)) is not null
       and not (has_table_privilege(format('%I.%I', current_schema(), v_table), 'UPDATE')
                and has_table_privilege(format('%I.%I', current_schema(), v_table), 'DELETE')) then
      v_missing := v_missing || v_table;
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise notice '%', format(
      '[0008] the migrating role %I cannot UPDATE and DELETE Better Auth table(s) %s in schema %I, so app_users_pseudonymise() would fail. Grant them (grant update, delete on %I."user", %I."session", %I."account", %I."verification" to %I;) before erasing anyone (docs/deployment.md, "Migration 0008").',
      current_user, array_to_string(v_missing, ', '), current_schema(),
      current_schema(), current_schema(), current_schema(), current_schema(), current_user);
  end if;
end $$;
-- ===== END folded 0008-user-data-export-erasure.sql =====
