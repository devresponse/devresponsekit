import "dotenv/config";
import { getMigrations } from "better-auth/db/migration";

/**
 * Better Auth migration runner.
 *
 * Better Auth manages its own tables. The runtime auth instance exposes
 * normalized options, and the package-level migration helper can compile
 * and apply the vendor schema for those options.
 */
async function main() {
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
