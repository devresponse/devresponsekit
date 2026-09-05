import { Pool, type PoolConfig } from "pg";

/**
 * Database schema configuration — the single source of truth for which
 * PostgreSQL schema this application's tables live in.
 *
 * EVERY table (the `app_*` tables AND the Better Auth vendor tables
 * `user`/`session`/`account`/`verification`) is deployed into ONE schema,
 * selected by `DB_SCHEMA` (default `auth`). The schema is applied at the
 * CONNECTION level via the libpq `search_path`, so every unqualified Kysely
 * query, every seed insert, and Better Auth's own migrator resolve to it
 * with no per-query schema qualification. This is what lets future
 * applications share one database while staying isolated by schema: a second
 * deployment simply sets a different `DB_SCHEMA` — no code changes.
 *
 * Extensions (pgcrypto, pg_trgm) stay in `public`, which is kept on the
 * search_path, so `gen_random_uuid()` / `gin_trgm_ops` resolve from any app
 * schema.
 *
 * This module intentionally does NOT import `server-only`: it must load from
 * `tsx` scripts (migrations, seeds, reset) as well as the Next.js app.
 */

/** A valid, unquoted SQL identifier. `DB_SCHEMA` is interpolated into DDL and
 * the connection `options` string, so it must never come from untrusted input. */
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i;

function resolveSchema(): string {
  const raw = (process.env.DB_SCHEMA ?? "auth").trim();
  if (!SCHEMA_RE.test(raw)) {
    throw new Error(
      `Invalid DB_SCHEMA "${raw}": must be a plain SQL identifier matching ${SCHEMA_RE} ` +
        "(it is interpolated into DDL and the connection search_path).",
    );
  }
  return raw;
}

/** The schema every table lives in. Configurable via `DB_SCHEMA` (default `auth`). */
export const DB_SCHEMA = resolveSchema();

/**
 * libpq `options` value applied to every connection so unqualified objects
 * resolve to `DB_SCHEMA` first, then `public` (for shared extensions).
 */
export const SEARCH_PATH_OPTION = `-c search_path="${DB_SCHEMA}",public`;

/**
 * Whether to send per-connection settings as libpq STARTUP parameters: the
 * `options` field carrying `search_path`, and — same switch, review #20 — the
 * runtime pool's `statement_timeout` / `idle_in_transaction_session_timeout`
 * (`src/db/database.ts`), which `pg` also places in the startup packet. ON by
 * default — works on a direct endpoint and local Postgres.
 *
 * A TRANSACTION-POOLING endpoint (Neon's pooled host, PgBouncer, Supabase's
 * pooler) REJECTS startup parameters — every connection fails with `08P01
 * unsupported startup parameter in options: search_path`. To run the app
 * against one, set `DB_SEARCH_PATH_VIA_OPTIONS=0` AND make all three
 * server-side role defaults so every connection still gets them:
 *
 *   ALTER ROLE <db_role> SET search_path = "<DB_SCHEMA>", public;
 *   ALTER ROLE <db_role> SET statement_timeout = '30s';
 *   ALTER ROLE <db_role> SET idle_in_transaction_session_timeout = '30s';
 *
 * Migrations/seeds/reset keep the option ON against the DIRECT endpoint (they
 * need it, plus DDL + advisory locks the pooler also can't do), so leave the
 * flag unset for those.
 */
export const SEARCH_PATH_VIA_OPTIONS = !/^(0|false|no|off)$/i.test(
  (process.env.DB_SEARCH_PATH_VIA_OPTIONS ?? "").trim(),
);

/**
 * Normalizes a Postgres connection string's `sslmode` for forward
 * compatibility with `pg` v9 / `pg-connection-string` v3.
 *
 * `pg-connection-string` currently treats `sslmode=prefer|require|verify-ca` as
 * the strict `verify-full` (validate the cert chain + hostname) but emits a
 * deprecation warning, because the next major adopts weaker libpq semantics for
 * those modes. Rewriting them to the explicit `verify-full` keeps today's
 * strict TLS behavior, silences the warning, and is stable across the change.
 * Neon / Supabase / RDS connection strings all use `sslmode=require`, so this
 * also makes the app robust to whatever a deployer pastes into `DATABASE_URL`.
 */
export function resolveDatabaseUrl(
  url: string | undefined = process.env.DATABASE_URL,
): string | undefined {
  if (!url) return url;
  return url.replace(/([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|$)/gi, "$1verify-full");
}

/**
 * Constructs a `pg` Pool whose every connection resolves to `DB_SCHEMA`. Use
 * this everywhere a Pool is created (app runtime, migrations, seeds, reset) so
 * the schema is configured in exactly one place.
 */
export function createAppPool(extra: PoolConfig = {}): Pool {
  return new Pool({
    connectionString: resolveDatabaseUrl(),
    // A transaction pooler rejects the `options` startup parameter, so omit it
    // when DB_SEARCH_PATH_VIA_OPTIONS is off and rely on a role-level
    // search_path instead (see SEARCH_PATH_VIA_OPTIONS above). The runtime
    // pool gates its timeout startup parameters on the same flag (review #20).
    ...(SEARCH_PATH_VIA_OPTIONS ? { options: SEARCH_PATH_OPTION } : {}),
    ...extra,
  });
}

/**
 * Idempotently creates the target schema. Call once from a privileged setup
 * entrypoint (migrations / seed / reset) BEFORE any other query — the runtime
 * app pool must never create schemas. Required because Better Auth's migrator
 * only WARNS on a missing schema and would otherwise create its tables in
 * `public`.
 */
export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`create schema if not exists "${DB_SCHEMA}"`);
}
