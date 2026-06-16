import "dotenv/config";
import { getMigrations } from "better-auth/db/migration";
import { createAppPool, ensureSchema } from "@/db/schema-config";

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
 */
async function main() {
  const boot = createAppPool();
  try {
    await ensureSchema(boot);
  } finally {
    await boot.end();
  }

  const { auth } = await import("@/lib/auth");
  const { runMigrations } = await getMigrations(
    auth.options as Parameters<typeof getMigrations>[0],
  );

  console.log("[auth:migrate] running Better Auth migrations...");
  await runMigrations();
  console.log("[auth:migrate] done");
}

main().catch((error) => {
  console.error("[auth:migrate] FAILED", error);
  process.exit(1);
});
