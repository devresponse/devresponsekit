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
