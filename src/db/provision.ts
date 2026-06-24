import "dotenv/config";
import { spawnSync } from "node:child_process";

/**
 * One-command database provisioning for a FRESH database (e.g. a brand-new Neon
 * project). Runs the full initial-setup path in order, fail-fast:
 *
 *   1. pnpm db:auth:migrate  — Better Auth tables (user/session/account/verification)
 *   2. pnpm db:app:migrate   — extensions (pgcrypto, pg_trgm) + app schema
 *                              (0001 … 0010), ledgered in `app_schema_migrations`
 *   3. pnpm db:seed          — default org, the `admin.*` permission catalog,
 *                              baseline roles, and the first admin (from
 *                              SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)
 *
 * Every step is idempotent, so this is safe to re-run against an already
 * provisioned database. The steps are driven through `spawnSync` (shell: true)
 * rather than a package.json `&&` chain, which is not portable across shells
 * (PowerShell has no `&&`); driving them from Node guarantees the same ordered,
 * fail-fast behaviour everywhere (this mirrors `pnpm db:reset --reload`, minus
 * the destructive drop).
 *
 * Requires DATABASE_URL. On a serverless Postgres such as Neon, point it at the
 * DIRECT / unpooled endpoint — migrations issue DDL + advisory locks and set a
 * per-connection `search_path`, all of which a transaction pooler drops:
 *
 *   DATABASE_URL="postgres://…(direct)…?sslmode=require" pnpm db:provision
 */

const STEPS: ReadonlyArray<{ label: string; command: string }> = [
  { label: "Better Auth tables", command: "pnpm db:auth:migrate" },
  { label: "application schema (extensions + 0001 … 0010)", command: "pnpm db:app:migrate" },
  { label: "baseline seed (org, permissions, roles, admin)", command: "pnpm db:seed" },
];

function describeTarget(url: string): { host: string; database: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname, database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "?" };
  } catch {
    return { host: "?", database: "?" };
  }
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[db:provision] DATABASE_URL is required.");
    process.exit(1);
  }

  const { host, database } = describeTarget(databaseUrl);
  console.log(`[db:provision] target  host=${host}  database=${database}`);
  console.log(`[db:provision] ${STEPS.length} steps, idempotent (safe to re-run) …`);

  let step = 0;
  for (const { label, command } of STEPS) {
    step += 1;
    console.log(`\n[db:provision] (${step}/${STEPS.length}) ${label}  (${command})`);
    const result = spawnSync(command, { stdio: "inherit", shell: true });
    if (result.status !== 0) {
      console.error(
        `[db:provision] aborted — "${command}" exited with code ${result.status ?? "signal"}.`,
      );
      process.exit(result.status ?? 1);
    }
  }

  console.log(
    "\n[db:provision] complete — database provisioned (Better Auth + app schema + seed).",
  );
}

main();
