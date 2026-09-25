import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** The refusal stub every satellite points its `db:*` scripts at. */
const OWNED_BY_KIT_STUB = "db-owned-by-kit";

/**
 * Does this checkout own a database schema — i.e. is it the kit (or a fork
 * still carrying a real migration runner) rather than a satellite?
 *
 * The satellites ALSO ship `src/db/migrations` (a truncated 0001-0002 set kept
 * for local type generation), so the directory alone proves nothing. What
 * separates them is the runner: a satellite's `db:app:migrate` is
 * `node scripts/db-owned-by-kit.mjs`, which is that app stating in its own
 * package.json that it does not own its schema. A checkout with a migrations
 * directory AND a real runner is a schema owner.
 */
export function looksLikeSchemaOwner(root: string): boolean {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return false;
  if (!existsSync(join(root, "src", "db", "migrations"))) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  const appMigrate = pkg.scripts?.["db:app:migrate"] ?? "";
  const authMigrate = pkg.scripts?.["db:auth:migrate"] ?? "";
  if (!appMigrate || !authMigrate) return false;
  return !appMigrate.includes(OWNED_BY_KIT_STUB) && !authMigrate.includes(OWNED_BY_KIT_STUB);
}

export interface SatelliteCheckout {
  /** `name` from the app's package.json, e.g. app-standalone. */
  name: string;
  /**
   * True when the checkout's own `db:*` scripts are the refusal stub
   * (`scripts/db-owned-by-kit.mjs`) rather than a real migration runner.
   *
   * This is not a curiosity: it is the satellites themselves stating that they
   * do not own their schema. When it is true, the safe default for
   * `satellite.database` is `shared-with-kit`, and `init` says so rather than
   * asking the operator to remember.
   */
  databaseOwnedByKit: boolean;
}

/**
 * Validates that a path is a satellite checkout — a consumer fork of the kit,
 * not the kit itself and not an unrelated Next app.
 *
 * Two conditions, and the second one is the one that costs something to leave
 * out. `/api/sso/consume` says "this app consumes handoffs", which is what a
 * satellite is for — but the KIT MOUNTS THAT ROUTE TOO (it is both an issuer
 * and a consumer of its own handoffs), so the consume route alone accepts the
 * kit as a satellite. That mistake is not cosmetic: the resulting config
 * deploys the KIT's source under the satellite contract (no signing key, the
 * satellite's audience), and because the kit's `db:app:migrate` is a real
 * runner rather than the refusal stub, `init` would then OFFER to record it as
 * owning its database.
 *
 * So a checkout that owns a schema is refused outright, and `kitRoot` — when
 * the caller knows it — is compared by resolved path as well. A safety claim
 * in a comment that the code does not enforce is worse than no claim at all:
 * this package's tests are the only thing that checks it.
 */
export function assertSatelliteRoot(appRoot: string, kitRoot?: string): SatelliteCheckout {
  const pkgPath = join(appRoot, "package.json");
  if (!existsSync(pkgPath)) {
    throw new CliError(`No package.json at ${appRoot}`, {
      hint: "Point --app-root at the satellite's own folder, e.g. C:\\my\\repos\\devresponseapps\\app-standalone",
    });
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  if (!pkg.scripts?.build) {
    throw new CliError(`${appRoot} has no \`build\` script — it cannot be deployed.`);
  }
  if (!existsSync(join(appRoot, "src", "app", "api", "sso", "consume"))) {
    throw new CliError(`${appRoot} has no /api/sso/consume route — it does not look like a satellite app.`, {
      hint: "A satellite is a consumer of the kit's SSO handoff. If you meant to deploy the kit itself, run `drk-deploy init` without --satellite.",
    });
  }
  if (kitRoot && resolve(appRoot) === resolve(kitRoot)) {
    throw new CliError(`${appRoot} is the KIT checkout, not a satellite.`, {
      hint: "The kit is the issuer and owns the schema. Run `drk-deploy init` without --satellite to configure it, or point --app-root at a satellite app folder.",
    });
  }
  if (looksLikeSchemaOwner(appRoot)) {
    throw new CliError(`${appRoot} owns a database schema — it is a primary, not a satellite.`, {
      hint: "It has src/db/migrations AND real db:app:migrate / db:auth:migrate scripts (a satellite points both at scripts/db-owned-by-kit.mjs). Deploying the kit under the satellite contract would strip its signing key and give it a satellite's audience.",
    });
  }
  const migrateScript = pkg.scripts["db:app:migrate"] ?? "";
  return {
    name: pkg.name ?? appRoot,
    databaseOwnedByKit: migrateScript.includes(OWNED_BY_KIT_STUB),
  };
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
