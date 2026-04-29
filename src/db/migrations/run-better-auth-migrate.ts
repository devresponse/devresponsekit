import "dotenv/config";

/**
 * Better Auth migration runner.
 *
 * Better Auth manages its own tables. In production environments the
 * recommended approach is to invoke the Better Auth CLI; this wrapper
 * keeps a single `pnpm db:auth:migrate` command available so developer
 * workflows do not need to remember the underlying CLI invocation.
 */
async function main() {
  // Lazy-import to avoid loading server-only modules during type checks
  // when DATABASE_URL is not configured.
  const { auth } = await import("@/lib/auth");

  // Some Better Auth versions expose a `runMigrations` API; if not
  // present the developer should fall back to the Better Auth CLI.
  const maybeRun = (auth as unknown as { runMigrations?: () => Promise<void> }).runMigrations;

  if (typeof maybeRun === "function") {
    console.log("[auth:migrate] running Better Auth migrations…");
    await maybeRun();
    console.log("[auth:migrate] done");
    return;
  }

  console.log(
    "[auth:migrate] No programmatic migration API detected for the installed Better Auth version.",
  );
  console.log(
    "[auth:migrate] Use the Better Auth CLI from your environment to apply auth migrations.",
  );
}

main().catch((error) => {
  console.error("[auth:migrate] FAILED", error);
  process.exit(1);
});
