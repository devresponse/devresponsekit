import "dotenv/config";
import { getMigrations } from "better-auth/db/migration";
import { migrationUrlProblem } from "@/db/connection-shape";
import { resolveMigrationLockWait } from "@/db/migration-lock";
import { createAppPool, DB_SCHEMA, ensureSchema } from "@/db/schema-config";
import {
  acquireMigrationLock,
  assertMigrationSession,
  createMigrationPool,
  MIGRATION_UNLOCK_SQL,
  resolveMigrationTimeouts,
  RUNNER_SESSION_STATEMENTS,
} from "@/db/migrations/apply-migration";

/**
 * Better Auth migration runner.
 *
 * Better Auth manages its own tables. The runtime auth instance exposes
 * normalized options, and the package-level migration helper can compile
 * and apply the vendor schema for those options.
 *
 * Better Auth's migrator follows the connection `search_path` (it reads
 * `SHOW search_path` and emits unqualified `create table`), so its tables
 * land in `DB_SCHEMA`. But it only WARNS on a missing schema — so we create
 * the schema FIRST, via a throwaway pool, before importing `@/lib/auth`
 * (which opens the shared runtime pool). This also makes a standalone
 * `pnpm db:auth:migrate` on a fresh database safe, and keeps the auth-first
 * order of `pnpm db:reset:reload` correct.
 *
 * The migrator runs on a pool of its own, not the runtime pool the options
 * name (F-94). Its `alter table` / `create index` statements hit `user` and
 * `session`, which every authenticated request reads; one of them waiting on
 * a lock would queue all of those behind it. `createMigrationPool` gives every
 * connection the same `lock_timeout` / `statement_timeout` the application
 * runner sets per file, for the whole session, because each of Better Auth's
 * statements auto-commits on its own.
 *
 * DEP2 gives it the application runner's guards. Before connecting it refuses
 * a pooled or re-pointed `DATABASE_URL` and a malformed
 * `DB_MIGRATE_LOCK_WAIT_MS`. Then one connection of the migration pool is held
 * for the run: it clears its own ceilings, takes the application runner's
 * advisory lock (it used to take none, so a hand run could interleave with a
 * deploy's), and refuses a search_path that does not resolve to DB_SCHEMA, or
 * a role that does not own the existing ledger, before `getMigrations` plans
 * anything (Better Auth's DDL is unqualified too). The lock is released in
 * `finally`, before the application runner, which runs next, asks for it.
 */
async function main() {
  // Resolved and checked before connecting, so a bad URL or a malformed value
  // fails with nothing touched (F-94, DEP2).
  const urlProblem = migrationUrlProblem(process.env.DATABASE_URL);
  if (urlProblem) {
    throw new Error(urlProblem);
  }
  const timeouts = resolveMigrationTimeouts();
  const lockWaitMs = resolveMigrationLockWait();
  const boot = createAppPool();
  try {
    await ensureSchema(boot);
  } finally {
    await boot.end();
  }

  const migrationPool = createMigrationPool(timeouts);
  // The session that holds the lock is checked out for the whole run, so
  // Better Auth's own statements go through the pool's other connections.
  const session = await migrationPool.connect();
  let locked = false;
  try {
    for (const statement of RUNNER_SESSION_STATEMENTS) {
      await session.query(statement);
    }
    await acquireMigrationLock(session, lockWaitMs);
    locked = true;
    await assertMigrationSession(session, DB_SCHEMA);

    const { auth } = await import("@/lib/auth");
    const { runMigrations } = await getMigrations({
      ...(auth.options as Parameters<typeof getMigrations>[0]),
      database: migrationPool,
    });

    console.log(
      `[auth:migrate] running Better Auth migrations (lock_timeout=${timeouts.lockTimeoutMs}ms statement_timeout=${timeouts.statementTimeoutMs}ms)...`,
    );
    await runMigrations();
    console.log("[auth:migrate] done");
  } finally {
    if (locked) {
      await session.query(MIGRATION_UNLOCK_SQL).catch(() => undefined);
    }
    session.release();
    await migrationPool.end();
  }
}

main().catch((error) => {
  console.error("[auth:migrate] FAILED", error);
  process.exit(1);
});
