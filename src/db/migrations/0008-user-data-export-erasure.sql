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
