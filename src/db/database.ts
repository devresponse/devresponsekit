import { Kysely, PostgresDialect } from "kysely";
import { createAppPool } from "./schema-config";
import { intFromEnv } from "@/lib/env";
import type { AppDatabase } from "./schema/app-schema";

/**
 * Shared PostgreSQL pool and Kysely instance.
 *
 * Application tables use Kysely directly. Better Auth uses a Kysely-
 * compatible adapter so that auth storage and app storage share the same
 * database without introducing Prisma or Drizzle.
 *
 * The pool is built via `createAppPool` so every connection starts with the
 * configured `search_path` (`DB_SCHEMA`, default `auth`) — see
 * `./schema-config`. This is the RUNTIME pool: it never creates schemas
 * (that is the migration/seed/reset tools' job).
 *
 * The pool is process-wide; do not call `db.destroy()` from request code.
 */
export const pgPool = createAppPool({
  // NaN-safe coercion (P2-12): `Number(x ?? N)` returned NaN for a non-numeric
  // value (`??` only catches null/undefined), and `pg` accepts NaN silently.
  // intFromEnv falls back to the default instead, and the same vars are
  // validated at boot by serverEnvSchema.
  max: intFromEnv("PGPOOL_MAX", 10),
  idleTimeoutMillis: 30_000,
  // Fail fast instead of blocking forever when every connection is checked
  // out. `pg` queues connection waiters with NO timeout by default, so a
  // burst of slow work (admin list endpoints take 2 connections each; an
  // export holds one across a multi-page scan) could otherwise wedge new
  // requests indefinitely. Tunable via PG_CONNECT_TIMEOUT_MS.
  connectionTimeoutMillis: intFromEnv("PG_CONNECT_TIMEOUT_MS", 5_000),
  // Server-side ceiling on a single statement, so one runaway scan can't pin
  // a connection. Applied per-statement (each export page is its own query),
  // so the default comfortably exceeds any legitimate page/list query.
  // Tunable via PG_STATEMENT_TIMEOUT_MS; raise it if a deployment runs
  // legitimately long single statements.
  statement_timeout: intFromEnv("PG_STATEMENT_TIMEOUT_MS", 30_000),
  // statement_timeout bounds a single statement, but a transaction that stalls
  // on an await BETWEEN statements would otherwise pin its connection + any
  // locks it holds indefinitely. Cap idle-in-transaction time so a stuck
  // request can't wedge the pool (P3-15). Tunable via PG_IDLE_IN_TX_TIMEOUT_MS.
  idle_in_transaction_session_timeout: intFromEnv("PG_IDLE_IN_TX_TIMEOUT_MS", 30_000),
});

export const db: Kysely<AppDatabase> = new Kysely<AppDatabase>({
  dialect: new PostgresDialect({ pool: pgPool }),
});
