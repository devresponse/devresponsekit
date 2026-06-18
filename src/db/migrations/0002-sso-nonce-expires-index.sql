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
