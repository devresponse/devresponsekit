-- 0004-integrity-constraints.sql
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
--        composite FKs, and on app_user_roles a trigger-maintained
--        `role_organization_id` with a composite FK for org-scoped roles
--        (global roles, organization_id IS NULL, are exempt from the FK by
--        MATCH SIMPLE and checked by the trigger instead).
--   #83  Audit-table role split: a NOLOGIN runtime role (`<schema>_runtime`)
--        with INSERT/SELECT only on app_audit_events, retention as a
--        SECURITY DEFINER function owned by the migration/owner role, and an
--        append-only trigger that permits a DELETE only when the effective
--        role is the table OWNER inside that function — no longer a bare GUC
--        any session could SET.
--
-- Rollout shape: every CHECK is added NOT VALID and then VALIDATEd (an
-- online pattern — VALIDATE takes only SHARE UPDATE EXCLUSIVE), and the
-- PREFLIGHT block below counts violating rows for EVERY new constraint first.
-- If any exist it raises with the full offender list (table, column, value,
-- count) and — because the runner applies this file in one transaction —
-- leaves the database unchanged. Nothing here edits data silently.
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
    raise exception '[0004] refusing to apply: % row group(s) violate a constraint this migration adds. Fix the data, then re-run. Offenders (table.column = value (count)): %',
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
alter table app_group_roles add column if not exists organization_id uuid;
update app_group_roles gr
   set organization_id = g.organization_id
  from app_groups g
 where g.id = gr.group_id
   and gr.organization_id is null;
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
        '[0004] created runtime role %I (NOLOGIN, no password). Enable it deliberately with: alter role %I login password ''<secret>''; then point the application DATABASE_URL at it (docs/deployment.md, "Least-privilege runtime role").',
        v_role, v_role);
    exception when insufficient_privilege then
      raise notice '%', format(
        '[0004] could not create runtime role %I (the migrating role lacks CREATEROLE); the rest of this migration still applies. Manual steps, as a role that can create roles: create role %I nologin; then re-run pnpm db:app:migrate (the grant block is idempotent) — or grant by hand: grant usage on schema %I to %I; grant select, insert, update, delete on all tables in schema %I to %I; alter default privileges in schema %I grant select, insert, update, delete on tables to %I; revoke update, delete, truncate on %I.app_audit_events from %I; grant execute on function %I.app_audit_events_prune(integer, integer) to %I.',
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
create or replace function app_audit_events_prune(p_days integer, p_batch integer)
  returns integer
  language plpgsql
  security definer
  set search_path from current
as $$
declare
  v_deleted integer;
begin
  if p_days is null or p_days <= 0 or p_batch is null or p_batch <= 0 then
    return 0;
  end if;
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
