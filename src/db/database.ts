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
});

export const db: Kysely<AppDatabase> = new Kysely<AppDatabase>({
  dialect: new PostgresDialect({ pool: pgPool }),
});
