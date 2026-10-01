import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWNER_WARNING,
  formatFailLine,
  formatPassLine,
  formatPlanLine,
  formatTargetLine,
  formatVerifyLine,
  planDeployGate,
  resolveHeadSha,
  runGateLoop,
} from "@/db/deploy-gate";
import { REQUIRED_CORE_MIGRATIONS } from "@/db/migrations/migration-plan";
import type * as SchemaConfig from "@/db/schema-config";

/**
 * The production build's schema gate (DEP1): `pnpm run vercel-build` runs
 * `next build && tsx scripts/deploy-gate.ts`, and `vercel.json` makes that the
 * build of every Vercel deployment. The rules are in src/db/deploy-gate.ts and
 * docs/deployment.md §1.1; this file only wires them up:
 *
 *   pnpm deploy:gate     # what the build runs after `next build`
 *
 * Exit 0: skipped (not a production build, or a local build that migrated
 * this commit first) or PASS. Exit 1: REFUSE or FAIL, and Vercel does not
 * promote the build, so the previous deployment keeps serving.
 *
 * Deliberately NO `dotenv/config`, unlike the migration runners: on a
 * developer's checkout `.env` holds a LOCAL DATABASE_URL, and a production
 * build whose own variable was missing would then check the wrong database
 * and pass. The gate reads only what the build environment holds.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/db/migrations",
);

const log = (line: string) => console.log(line);

/** HEAD of the checkout being built, for a local `vercel build`; null when git cannot say. */
function gitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** This build's core migration files, by ledger id, for the checksum comparison. */
function readCoreFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const id of REQUIRED_CORE_MIGRATIONS) {
    try {
      files.set(id, readFileSync(path.join(MIGRATIONS_DIR, id), "utf8"));
    } catch {
      // Reported by evaluateLedger as a file it could not compare.
    }
  }
  return files;
}

async function main(): Promise<number> {
  const plan = planDeployGate(process.env, resolveHeadSha(process.env, gitHead));
  if (plan.action !== "verify") {
    log(formatPlanLine(plan));
    return plan.action === "skip" ? 0 : 1;
  }
  log(formatVerifyLine(plan));

  // A socket that hangs past every timeout must not hold the build until
  // Vercel's own limit: fail with a minute to spare after the wait.
  const deadline = setTimeout(() => {
    log(
      formatFailLine("timeout", [
        `the check did not finish within ${Math.round((plan.waitMs + 60_000) / 1000)}s`,
      ]),
    );
    process.exit(1);
  }, plan.waitMs + 60_000);
  deadline.unref();

  // Loaded only to verify: a skipped or refused build never touches pg.
  // schema-config resolves DB_SCHEMA on import and throws on a malformed one.
  let schemaConfig: typeof SchemaConfig;
  try {
    schemaConfig = await import("@/db/schema-config");
  } catch (err) {
    log(formatPlanLine({ action: "refuse", reason: (err as Error).message }));
    return 1;
  }
  const { checkDatabase } = await import("@/db/migrations/deploy-gate-check");
  const pool = schemaConfig.createAppPool({
    max: 1,
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
  });
  // An idle client's socket error is reported by the next attempt, not thrown here.
  pool.on("error", () => undefined);

  try {
    // Better Auth's options, for its migrator's plan only. A server
    // environment the auth module refuses is a deployment that could not
    // serve, so it fails the build too; only the invalid key NAMES are
    // printed, never a value (F-26).
    let betterAuth: Parameters<typeof checkDatabase>[1]["betterAuth"];
    try {
      const { auth } = await import("@/lib/auth");
      const { getMigrations } = await import("better-auth/db/migration");
      betterAuth = (database) =>
        getMigrations(
          { ...(auth.options as Parameters<typeof getMigrations>[0]), database },
          { throwOnUnsafe: false },
        );
    } catch (err) {
      const { invalidServerEnvKeys } = await import("@/lib/env");
      const keys = invalidServerEnvKeys();
      log(
        formatFailLine("fatal", [
          keys.length > 0
            ? `the server environment is invalid (${keys.join(", ")}), so the deployment could not serve`
            : `the auth module failed to load: ${(err as Error).message}`,
        ]),
      );
      return 1;
    }

    const files = readCoreFiles();
    const said = new Set<string>();
    let targetShown = false;
    let isOwner = true;
    const outcome = await runGateLoop({
      attempt: async () => {
        const result = await checkDatabase(pool, {
          schema: schemaConfig.DB_SCHEMA,
          files,
          betterAuth,
        });
        if (result.identity) isOwner = result.identity.isOwner;
        if (result.identity && !targetShown) {
          targetShown = true;
          log(
            formatTargetLine(
              plan.databaseUrl,
              schemaConfig.DB_SCHEMA,
              result.identity.currentUser,
              result.identity.isOwner,
            ),
          );
          if (result.identity.isOwner) log(OWNER_WARNING);
        }
        for (const warning of result.warnings) {
          if (said.has(warning)) continue;
          said.add(warning);
          log(`[deploy-gate] warning: ${warning}`);
        }
        return result;
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      waitMs: plan.waitMs,
      pollMs: plan.pollMs,
      log,
    });

    if (outcome.outcome === "pass") {
      log(formatPassLine(outcome.elapsedMs, isOwner));
      return 0;
    }
    log(formatFailLine(outcome.kind, outcome.reasons));
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main()
  .catch((err: unknown) => {
    log(formatFailLine("fatal", [`the gate itself failed: ${(err as Error)?.message ?? err}`]));
    return 1;
  })
  .then((code) => process.exit(code));
