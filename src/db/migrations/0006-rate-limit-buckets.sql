-- 0006-rate-limit-buckets.sql
--
-- Shared token-bucket storage for the PRE-AUTH rate-limit floors (source
-- review 2026-09-04, #98). The in-process limiter in
-- `src/lib/admin/rate-limit.server.ts` keeps its budget in one Node process's
-- memory, so on Vercel — one lambda per concurrent invocation — the
-- "deployment-wide" floors on the token endpoint, MCP registration, the CSP
-- report sink and invitation acceptance were really per-lambda floors, and a
-- distributed run that fanned out across invocations multiplied every budget
-- by the instance count. This table is the cluster-wide store those floors
-- now consume from (`src/lib/admin/rate-limit-shared.server.ts`).
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
