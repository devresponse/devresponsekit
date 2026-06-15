import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { AppDatabase } from "./schema/app-schema";

/**
 * Shared PostgreSQL pool and Kysely instance.
 *
 * Application tables use Kysely directly. Better Auth uses a Kysely-
 * compatible adapter so that auth storage and app storage share the same
 * database without introducing Prisma or Drizzle.
 *
 * The pool is process-wide; do not call `db.destroy()` from request code.
 */
const connectionString = process.env.DATABASE_URL;

export const pgPool = new Pool({
  connectionString,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  // Fail fast instead of blocking forever when every connection is checked
  // out. `pg` queues connection waiters with NO timeout by default, so a
  // burst of slow work (admin list endpoints take 2 connections each; an
  // export holds one across a multi-page scan) could otherwise wedge new
  // requests indefinitely. Tunable via PG_CONNECT_TIMEOUT_MS.
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5_000),
  // Server-side ceiling on a single statement, so one runaway scan can't pin
  // a connection. Applied per-statement (each export page is its own query),
  // so the default comfortably exceeds any legitimate page/list query.
  // Tunable via PG_STATEMENT_TIMEOUT_MS; raise it if a deployment runs
  // legitimately long single statements.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30_000),
});

export const db: Kysely<AppDatabase> = new Kysely<AppDatabase>({
  dialect: new PostgresDialect({ pool: pgPool }),
});
