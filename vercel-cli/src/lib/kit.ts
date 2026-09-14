import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runPnpm } from "./exec.js";
import { CliError, step } from "./log.js";

/**
 * The devresponsekit checkout that OWNS the database schema.
 *
 * Migrations are run from source, never from the deployed bundle: the runtime
 * image does not ship `tsx` or `src/db`, and the kit's migration runner takes a
 * Postgres advisory lock and keeps a checksum ledger, so it must reach the
 * database directly.
 */

export function assertKitRoot(kitRoot: string): void {
  const pkgPath = join(kitRoot, "package.json");
  if (!existsSync(pkgPath)) {
    throw new CliError(`No package.json at ${kitRoot}`, {
      hint: "Point --kit-root at a devresponsekit checkout.",
    });
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  for (const required of ["db:app:migrate", "db:auth:migrate"]) {
    if (!pkg.scripts?.[required]) {
      throw new CliError(`${kitRoot} has no \`${required}\` script — it does not look like devresponsekit.`);
    }
  }
  if (!existsSync(join(kitRoot, "src", "db", "migrations"))) {
    throw new CliError(`${kitRoot} has no src/db/migrations directory.`);
  }
}

/** The core migration files this checkout would apply, in order. */
export function coreMigrations(kitRoot: string): string[] {
  const dir = join(kitRoot, "src", "db", "migrations");
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.sql$/.test(f))
    .sort();
}

export interface MigrateOptions {
  kitRoot: string;
  /** The DIRECT (non-pooled) connection string. */
  databaseUrl: string;
  schema: string;
  dryRun: boolean;
}

/**
 * Applies the application migrations and then the Better Auth ones.
 *
 * Order matters and so does the direction: DDL and the advisory lock must not
 * travel through a transaction pooler, which is why this insists on the direct
 * endpoint. Both runners are idempotent and ledgered, so re-running a deploy
 * that changed no migrations is a no-op.
 */
export async function applyMigrations(options: MigrateOptions): Promise<void> {
  assertKitRoot(options.kitRoot);

  if (options.dryRun) {
    step(`[dry-run] would run \`pnpm db:app:migrate\` then \`pnpm db:auth:migrate\` in ${options.kitRoot}`);
    return;
  }

  const env = { DATABASE_URL: options.databaseUrl, DB_SCHEMA: options.schema };

  step("Applying application migrations (pnpm db:app:migrate)");
  await runPnpm(["db:app:migrate"], {
    cwd: options.kitRoot,
    env,
    failureMessage: "Application migrations failed — production was NOT promoted",
  });

  step("Applying Better Auth migrations (pnpm db:auth:migrate)");
  await runPnpm(["db:auth:migrate"], {
    cwd: options.kitRoot,
    env,
    failureMessage: "Better Auth migrations failed — production was NOT promoted",
  });
}

/** Installs dependencies in the kit checkout so the migration runner can run. */
export async function ensureKitDependencies(kitRoot: string, dryRun: boolean): Promise<void> {
  if (existsSync(join(kitRoot, "node_modules", "tsx"))) return;
  if (dryRun) {
    step("[dry-run] would run `pnpm install --frozen-lockfile` in the kit checkout");
    return;
  }
  step("Installing kit dependencies (needed by the migration runner)");
  await runPnpm(["install", "--frozen-lockfile"], {
    cwd: kitRoot,
    failureMessage: "pnpm install failed in the kit checkout",
  });
}
