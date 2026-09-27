import "dotenv/config";
import { getMigrations } from "better-auth/db/migration";
import { createAppPool, ensureSchema } from "@/db/schema-config";
import { createMigrationPool, resolveMigrationTimeouts } from "@/db/migrations/apply-migration";

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
 */
async function main() {
  // Resolved before connecting, so a malformed value fails with nothing
  // touched (F-94).
  const timeouts = resolveMigrationTimeouts();
  const boot = createAppPool();
  try {
    await ensureSchema(boot);
  } finally {
    await boot.end();
  }

  const { auth } = await import("@/lib/auth");
  const migrationPool = createMigrationPool(timeouts);
  try {
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
    await migrationPool.end();
  }
}

main().catch((error) => {
  console.error("[auth:migrate] FAILED", error);
  process.exit(1);
});
