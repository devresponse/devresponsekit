import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ProjectConfig, deployRoot, requireConfig, requireToken } from "../lib/config.js";
import { runOrThrow } from "../lib/exec.js";
import {
  probe,
  probeConsumer,
  describe,
  describeConsumer,
  isConsumerHealthy,
  isHealthy,
  jwksKeyCount,
} from "../lib/health.js";
import { applyMigrations, coreMigrations, ensureKitDependencies } from "../lib/kit.js";
import { CliError, bold, dim, field, green, heading, info, ok, red, step, warn, yellow } from "../lib/log.js";
import {
  DEFAULT_SCHEMA,
  type MigrationTarget,
  parsePostgresUrl,
  pooledReason,
  redactUrl,
  repointedError,
  repointingParams,
  verifyMigrationTarget,
} from "../lib/migration-target.js";
import { type DeploymentProfile, describeProfile, migrationPolicy, resolveProfile } from "../lib/target.js";
import { envCheck, envSync, parseEnvFile, reportContainment } from "./env.js";

// Kept importable from here, where it lived before F-47 moved it next to the
// checks that print it.
export { redactUrl };

/**
 * The pinned Vercel CLI, as a JavaScript entry point rather than its `.cmd`
 * shim: running it through `node` keeps the whole pipeline shell-free on
 * Windows, so nothing this CLI passes can be re-parsed by cmd.exe.
 */
function vercelEntry(cliRoot: string): string {
  const entry = join(cliRoot, "node_modules", "vercel", "dist", "vc.js");
  if (!existsSync(entry)) {
    throw new CliError("The pinned Vercel CLI is not installed.", {
      hint: "Run `pnpm install` inside vercel-cli.",
    });
  }
  return entry;
}

/** A migration URL, and where it came from, for the operator to check. */
export interface MigrationUrl {
  url: string;
  source: string;
}

/**
 * Resolves the connection string migrations run against, from an EXPLICIT
 * source only.
 *
 * Deliberately separate from the runtime `DATABASE_URL`: a deployment usually
 * runs against a POOLED endpoint, while DDL and the migration runner's advisory
 * lock must use the DIRECT one. Getting this wrong fails in a confusing way
 * (the lock silently does nothing through a transaction pooler), so a pooled
 * shape is refused up front unless explicitly allowed.
 *
 * The sources, in order: `--database-url`, then the target's own variable in
 * the shell, then the same variable in the `--from-env` file. The shell wins
 * over a file, and an empty or blank shell value counts as unset, both as they
 * do for `env:sync` (`loadSuppliedValues`): a CI step that exports
 * `${{ secrets.X }}` exports "" when the secret is missing, and that must not
 * hide the file. An explicit `--database-url ""` is refused, never skipped
 * over: the flag says where the URL was meant to come from. The kit's variable is
 * PRODUCTION_DIRECT_DATABASE_URL, a satellite's SATELLITE_DIRECT_DATABASE_URL.
 * The kit used to fall back to DIRECT_DATABASE_URL and then DATABASE_URL, and
 * on the machine a deploy runs from `DATABASE_URL` is usually the LOCAL
 * database: `up` migrated it, printed "Migrations applied", and promoted a
 * build that expected the new schema over a production that did not have it
 * (F-47). Neither is read now. `deploy`, `up` and `migrate` then check the
 * URL against production itself (`verifyMigrationTarget`).
 *
 * A satellite never reads the kit's variable: a shell set up to deploy the
 * primary has PRODUCTION_DIRECT_DATABASE_URL pointing at the primary's
 * database, and inheriting it would migrate the KIT's database from a
 * satellite's config. It would look like it worked, too, because the
 * migrations are the kit's either way.
 *
 * Exported, with the environment injectable, so the precedence and the
 * pooled check are table-tested without touching `process.env` (F-45).
 */
export function resolveMigrationUrl(
  options: { databaseUrl?: string; allowPooled?: boolean; satellite?: boolean; fromEnv?: string },
  env: NodeJS.ProcessEnv = process.env,
): MigrationUrl {
  const variable = options.satellite ? "SATELLITE_DIRECT_DATABASE_URL" : "PRODUCTION_DIRECT_DATABASE_URL";
  const inFile = options.fromEnv ? readEnvFile(options.fromEnv)[variable] : undefined;
  const inShell = env[variable]?.trim() ? env[variable] : undefined;

  const resolved: MigrationUrl | null =
    options.databaseUrl !== undefined
      ? { url: options.databaseUrl, source: "--database-url" }
      : inShell !== undefined
        ? { url: inShell, source: `${variable} in the shell` }
        : inFile
          ? { url: inFile, source: `${variable} in ${options.fromEnv}` }
          : null;

  if (!resolved?.url.trim()) {
    // Name the variables that ARE set and were passed over, so the operator
    // whose deploy used to work off DATABASE_URL learns why it stopped.
    const passedOver = options.satellite
      ? []
      : ["DIRECT_DATABASE_URL", "DATABASE_URL"].filter((key) => env[key]);
    // And the sources that were there but empty, so "set it" is not the
    // advice for a variable that is already set (to nothing).
    const empty = [
      ...(options.databaseUrl !== undefined ? ["--database-url was given an EMPTY value."] : []),
      ...(env[variable] !== undefined && inShell === undefined
        ? [
            `${variable} is set in the shell but EMPTY (a CI step exporting a secret that is not defined exports an empty string).`,
          ]
        : []),
    ];
    const where = options.fromEnv
      ? "in the shell or the --from-env file"
      : "in the shell or a --from-env file";
    throw new CliError("No database URL for migrations.", {
      hint: [
        ...empty,
        options.satellite
          ? `A satellite must name its own database: pass --database-url <direct-url>, or set SATELLITE_DIRECT_DATABASE_URL ${where}. The kit's PRODUCTION_DIRECT_DATABASE_URL is deliberately NOT used here.`
          : `Pass --database-url <direct-url>, or set PRODUCTION_DIRECT_DATABASE_URL ${where}. Use the DIRECT (non-pooled) endpoint.`,
        ...(passedOver.length > 0
          ? [
              `${passedOver.join(" and ")} ${passedOver.length > 1 ? "are" : "is"} set but deliberately NOT used (F-47): on the machine a deploy runs from it is usually a local or test database, and migrating that would let the new build be promoted over an unmigrated production.`,
            ]
          : []),
      ].join(" "),
    });
  }

  const parsed = parsePostgresUrl(resolved.url);
  if (!parsed) {
    throw new CliError(`The migration URL (${resolved.source}) is not a postgres:// connection string.`, {
      hint: "Use the direct endpoint's full URL, postgresql://user:password@host/database, with any reserved character in the password percent-encoded.",
    });
  }
  // Before the pooled check, which reads the authority too: `?port=6543`
  // would otherwise get a pooled URL past it.
  const repointed = repointingParams(parsed);
  if (repointed.length > 0) throw repointedError(repointed);
  const pooled = pooledReason(parsed);
  if (pooled && !options.allowPooled) {
    throw new CliError(`That looks like a POOLED connection string: ${pooled}.`, {
      hint: "Migrations need the direct endpoint: DDL and the runner's advisory lock do not survive a transaction pooler. Pass --allow-pooled to override.",
    });
  }
  return resolved;
}

/** A `.env` file's values, for the one variable `resolveMigrationUrl` reads from it. */
function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) throw new CliError(`No such file: ${file}`);
  return parseEnvFile(readFileSync(file, "utf8"));
}

/**
 * The guard in front of every migration: a satellite on the kit's database
 * does not own its schema. There is no --force: the escape is to record in
 * the config that it owns its own (see `migrationPolicy`), which is a
 * decision that outlives the session.
 */
function assertMayMigrate(profile: DeploymentProfile): void {
  const policy = migrationPolicy(profile);
  if (policy.allowed) return;
  heading("Database migrations");
  field("target", describeProfile(profile));
  info("");
  throw new CliError(policy.why, {
    ...(policy.hint ? { hint: policy.hint } : {}),
    exitCode: 2,
  });
}

/**
 * Applies the kit's migrations to the database it is handed: the step
 * `deploy`, `up` and `drk-deploy migrate` run once the target has been
 * checked against production (`verifyMigrationTarget`). The guards here run
 * again anyway, before anything is resolved or installed, because this is
 * the function that touches the database.
 */
export async function migrate(
  cliRoot: string,
  options: { databaseUrl?: string; schema?: string; allowPooled?: boolean; dryRun?: boolean },
): Promise<void> {
  const config = requireConfig(cliRoot);
  const profile = resolveProfile(config);
  assertMayMigrate(profile);

  const isSatellite = profile.kind === "satellite";
  const { url: databaseUrl } = resolveMigrationUrl({ ...options, satellite: isSatellite });
  const schema = options.schema ?? DEFAULT_SCHEMA;

  heading("Database migrations");
  field("target", describeProfile(profile));
  field("kit checkout", config.kitRoot);
  field("schema", schema);
  field("endpoint", dim(redactUrl(databaseUrl)));
  const migrations = coreMigrations(config.kitRoot);
  field("core migrations", `${migrations.length} on disk (${migrations.at(-1) ?? "none"} newest)`);
  if (isSatellite) {
    info("");
    // Worth saying out loud: the satellites' own migration runners are the
    // refusal stub, so the schema still comes from the kit checkout — it is
    // simply being applied to a database the satellite owns.
    warn("Applying the KIT's migration set to a satellite-owned database. Check the endpoint above.");
  }
  info("");

  await ensureKitDependencies(config.kitRoot, options.dryRun ?? false);
  await applyMigrations({ kitRoot: config.kitRoot, databaseUrl, schema, dryRun: options.dryRun ?? false });

  if (!options.dryRun) ok("Migrations applied (idempotent and ledgered — a re-run is a no-op)");
}

/** The options every command that migrates takes. */
interface MigrationOptions {
  fromEnv?: string;
  databaseUrl?: string;
  schema?: string;
  allowPooled?: boolean;
  allowUnverifiedTarget?: boolean;
  forceSchema?: boolean;
}

/**
 * `drk-deploy migrate`: link → pull → check the target → migrate, the first
 * half of `deploy`.
 *
 * On its own this command used to migrate whatever URL it resolved, into
 * `auth` unless told otherwise, with nothing to compare either against. It
 * now reads production's settings the way `deploy` does, so a stray URL or a
 * production on another DB_SCHEMA is refused here too (F-47). The guards run
 * first, so a refused migration spawns nothing.
 */
export async function migrateCommand(
  cliRoot: string,
  options: MigrationOptions & { dryRun?: boolean },
  runner: ReleaseRunner = releaseRunner,
): Promise<void> {
  const config = requireConfig(cliRoot);
  const profile = resolveProfile(config);
  assertMayMigrate(profile);
  const migration = resolveMigrationUrl({ ...options, satellite: profile.kind === "satellite" });

  if (options.dryRun) {
    await dryRunMigration(cliRoot, migration, options, runner);
    return;
  }

  const vercel = vercelInvocation(cliRoot, config, profile);
  await withProductionEnv(vercel, runner, async (production) => {
    const target = checkMigrationTarget(migration, production(), options);
    await runner.migrate(cliRoot, migrationStep(migration, target, options));
  });
}

/**
 * A dry run spawns no Vercel CLI, so production's settings are never pulled
 * and the target cannot be checked. It says so rather than implying a check
 * that did not happen.
 */
async function dryRunMigration(
  cliRoot: string,
  migration: MigrationUrl,
  options: MigrationOptions,
  runner: ReleaseRunner,
): Promise<void> {
  heading("Migration target");
  field("migrating", `${redactUrl(migration.url)} ${dim(`(${migration.source})`)}`);
  step(
    "[dry-run] production's settings are not pulled, so this is NOT checked against production, and the schema is `auth` unless --schema says otherwise. A real run checks both first.",
  );
  await runner.migrate(cliRoot, {
    databaseUrl: migration.url,
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.allowPooled !== undefined ? { allowPooled: options.allowPooled } : {}),
    dryRun: true,
  });
}

/**
 * Prints what is about to be migrated, then refuses it unless it is
 * production's (F-47). Values are printed redacted: host, user and database,
 * never the password.
 */
function checkMigrationTarget(
  migration: MigrationUrl,
  production: Readonly<Record<string, string>>,
  options: MigrationOptions,
): MigrationTarget {
  heading("Migration target");
  field("migrating", `${redactUrl(migration.url)} ${dim(`(${migration.source})`)}`);
  const target = verifyMigrationTarget({
    url: migration.url,
    production,
    schema: options.schema,
    allowUnverifiedTarget: options.allowUnverifiedTarget,
    forceSchema: options.forceSchema,
  });
  if (target.matched) {
    field("production", `${redactUrl(target.matched.url)} ${dim(`(${target.matched.key})`)}`);
    ok("The same database production reads (host and database name match)");
  }
  field("schema", `${target.schema} ${dim(`(${target.schemaReason})`)}`);
  for (const line of target.overrides) warn(line);
  return target;
}

/** What the migrate step is handed once the target is checked: the URL and the schema, nothing to re-resolve. */
function migrationStep(
  migration: MigrationUrl,
  target: MigrationTarget,
  options: MigrationOptions,
): { databaseUrl: string; schema: string; allowPooled?: boolean } {
  return {
    databaseUrl: migration.url,
    schema: target.schema,
    ...(options.allowPooled !== undefined ? { allowPooled: options.allowPooled } : {}),
  };
}

/**
 * One run of the pinned Vercel CLI: the entry point, the project it acts on,
 * the checkout it runs in, and the environment the token travels in.
 */
export interface VercelInvocation {
  vercelJs: string;
  config: ProjectConfig;
  root: string;
  env: Record<string, string>;
}

/**
 * Every step `deploy`, `up` and `migrate` put in order, behind one seam
 * (F-45).
 *
 * The order is this CLI's safety property: environment, then production's
 * settings, then migrations checked against them, then build and promote,
 * then verify, with nothing after a failure. It used to live only in
 * straight-line calls to functions that spawn `vercel` or open the production
 * database, which no test could run, so a refactor that promoted before
 * migrating, or carried on past a failed migration, passed every check. The
 * commands now reach each step through this interface: {@link releaseRunner}
 * is the real one, and the CLI's tests pass a recording fake and assert the
 * order itself. Anything the commands do that reaches Vercel, a database or a
 * subprocess belongs here, so a test of the ordering can never reach one.
 *
 * `pull` comes BEFORE `migrate` (F-47). It is read-only on Vercel's side, and
 * what it writes, production's own variables, is what the migration URL and
 * schema are checked against before anything is migrated.
 */
export interface ReleaseRunner {
  /** `drk-deploy env:sync`. Only `up` runs it. */
  envSync: typeof envSync;
  /** `drk-deploy env:check`, the preflight: the number of problems found. */
  envCheck: typeof envCheck;
  /** `vercel link`, when the checkout has no `.vercel/project.json` yet. */
  link(vercel: VercelInvocation): Promise<void>;
  /**
   * `vercel pull`: production's variables and project settings, written to
   * `.vercel/.env.production.local` in the checkout (see {@link pulledEnvFile}).
   */
  pull(vercel: VercelInvocation): Promise<void>;
  /** The migrations, on a target already checked against production. */
  migrate: typeof migrate;
  /** `vercel build --prod`. */
  build(vercel: VercelInvocation): Promise<void>;
  /** `vercel deploy --prebuilt --prod`: the promotion. */
  promote(vercel: VercelInvocation): Promise<void>;
  /** The post-deploy probes. */
  verify(config: ProjectConfig, profile: DeploymentProfile): Promise<void>;
}

/** The real steps. The commands use these unless a test passes its own. */
export const releaseRunner: ReleaseRunner = {
  envSync,
  envCheck,
  link: ensureLinked,
  pull: (vercel) => runVercel(vercel, ["pull", "--yes", "--environment=production"], "vercel pull failed"),
  migrate,
  build: (vercel) => runVercel(vercel, ["build", "--prod"], "vercel build failed — nothing was promoted"),
  promote: (vercel) => runVercel(vercel, ["deploy", "--prebuilt", "--prod"], "vercel deploy failed"),
  verify,
};

/** Runs the pinned Vercel CLI in the deployed checkout. A non-zero exit throws. */
async function runVercel(
  { vercelJs, root, env }: VercelInvocation,
  args: string[],
  failureMessage: string,
): Promise<void> {
  await runOrThrow(process.execPath, [vercelJs, ...args], { cwd: root, env, failureMessage });
}

/**
 * The Vercel CLI invocation for this deployment: the pinned entry point, the
 * checkout, and the token.
 */
function vercelInvocation(
  cliRoot: string,
  config: ProjectConfig,
  profile: DeploymentProfile,
): VercelInvocation {
  const token = requireToken();
  const vercelJs = vercelEntry(cliRoot);
  const root = deployRoot(config);
  if (!existsSync(root)) {
    // Caught here rather than as a confusing spawn error three steps later,
    // when `vercel pull` is handed a working directory that does not exist.
    throw new CliError(`The checkout to deploy does not exist: ${root}`, {
      hint:
        profile.kind === "satellite"
          ? "Re-run `drk-deploy init --app-root <path-to-the-satellite-checkout>`."
          : "Re-run `drk-deploy init --kit-root <path-to-the-kit-checkout>`.",
    });
  }
  // The token travels in the environment, never in argv: an argument list is
  // visible to other processes and lands in shell history.
  const env = {
    VERCEL_TOKEN: token,
    ...(config.teamId ? { VERCEL_ORG_ID: config.teamId } : {}),
    VERCEL_PROJECT_ID: config.projectId,
  };
  return { vercelJs, config, root, env };
}

/**
 * Where `vercel pull --environment=production` writes production's variables:
 * `.vercel/.env.production.local` in the checkout it runs in (vercel 59.x,
 * `pullAllEnvFiles`). `vercel build` reads the same file.
 */
export function pulledEnvFile(root: string): string {
  return join(root, ".vercel", ".env.production.local");
}

/**
 * link → pull, then `body` with production's variables, then the pulled file
 * is deleted however `body` ended.
 *
 * That file holds production's secrets in plain text, every one the token may
 * decrypt, so it lives only as long as the run needs it: `vercel build` reads
 * it, and nothing after the promotion does. It is gitignored as well (the
 * kit's `.gitignore` ignores `.vercel` and `.env.*.local`), but a file that
 * is not there cannot be committed, copied or left behind.
 *
 * A copy already on disk is deleted BEFORE the pull too. `vercel pull` does
 * not replace it: it keeps every local key that production lacks, and keeps
 * the local value of any key production stores `sensitive`. A stale file
 * could therefore vouch for a database production no longer reads (F-47).
 * Production's variables are read only on demand, so a run with no migration
 * step never parses them.
 */
async function withProductionEnv(
  vercel: VercelInvocation,
  runner: ReleaseRunner,
  body: (production: () => Record<string, string>) => Promise<void>,
): Promise<void> {
  heading("Production settings");
  await runner.link(vercel);
  const file = pulledEnvFile(vercel.root);
  rmSync(file, { force: true });
  try {
    step("Pulling production environment and project settings (read-only)");
    await runner.pull(vercel);
    await body(() => readPulledEnv(file));
  } finally {
    rmSync(file, { force: true });
  }
}

/** Production's variables from the file `vercel pull` just wrote. Missing means unknown, never empty. */
function readPulledEnv(file: string): Record<string, string> {
  if (!existsSync(file)) {
    throw new CliError(
      `vercel pull wrote no ${file}, so production's database is unknown. Nothing was migrated.`,
      {
        exitCode: 2,
        hint: "A repository-level link (`.vercel/repo.json`) writes it under the project's root directory instead. Link this checkout itself (`vercel link` in it) and re-run.",
      },
    );
  }
  return parseEnvFile(readFileSync(file, "utf8"));
}

/**
 * `drk-deploy deploy`: pull production's settings, migrate (checked against
 * them), then build, then promote.
 *
 * The order is the whole point. Migrations run BEFORE the new build is
 * promoted, so the currently-live build keeps serving against a schema it
 * understands; promoting first is how you get a live deployment 500ing on
 * every request against a table that does not exist yet. If migrations fail,
 * nothing is promoted. And the migrations must land in the database and the
 * schema the promoted build reads, so they are checked against production's
 * own `DATABASE_URL` and `DB_SCHEMA` first (F-47): migrating anything else
 * and then promoting is the same outage, reached with every step green.
 */
export async function deploy(
  cliRoot: string,
  options: MigrationOptions & {
    skipMigrations?: boolean;
    skipChecks?: boolean;
    dryRun?: boolean;
    yes?: boolean;
  },
  runner: ReleaseRunner = releaseRunner,
): Promise<void> {
  const config = requireConfig(cliRoot);
  const profile = resolveProfile(config);
  const vercel = vercelInvocation(cliRoot, config, profile);

  heading("Preflight");
  field("target", describeProfile(profile));
  field("checkout", vercel.root);
  if (options.skipChecks) {
    warn("--skip-checks: the environment contract was not verified.");
    // `env:check` is what prints the containment warning (F-24), and `up`
    // always lands here with it skipped. Skipping the contract must not skip
    // the one warning that is about the topology rather than a variable.
    reportContainment(profile, config.origin);
  } else {
    const problems = await runner.envCheck(cliRoot);
    if (problems > 0 && !options.yes) {
      throw new CliError(`${problems} environment problem(s).`, {
        hint: "Each WRONG line above names its fix, and `drk-deploy env:sync` fills in what is missing. Or re-run with --yes to deploy anyway.",
      });
    }
  }

  const policy = migrationPolicy(profile);
  let migration: MigrationUrl | null = null;
  if (options.skipMigrations) {
    warn("--skip-migrations: the schema was NOT touched. Only safe when nothing changed.");
  } else if (!policy.allowed) {
    // Not an error: deploying a satellite that shares the kit's database is
    // an ordinary thing to do. It simply has no migration step, and the safe
    // order for it is env → pull → build → promote → verify.
    heading("Database migrations");
    step("Skipped by policy — this deployment does not own its schema.");
    info(`  ${dim(policy.why)}`);
    if (policy.hint) info(`  ${dim(policy.hint)}`);
  } else {
    // Resolved now, before anything is spawned: a run with no migration URL
    // stops here rather than after linking and pulling.
    migration = resolveMigrationUrl({ ...options, satellite: profile.kind === "satellite" });
  }

  if (options.dryRun) {
    if (migration) await dryRunMigration(cliRoot, migration, options, runner);
    heading("Build and promote");
    step(
      `[dry-run] would run: vercel pull → ${migration ? "check the migration target → migrate → " : ""}vercel build --prod → vercel deploy --prebuilt --prod`,
    );
    return;
  }

  await withProductionEnv(vercel, runner, async (production) => {
    if (migration) {
      const target = checkMigrationTarget(migration, production(), options);
      await runner.migrate(cliRoot, migrationStep(migration, target, options));
    }

    heading("Build and promote");
    step("Building");
    await runner.build(vercel);

    step("Promoting the prebuilt output to production");
    await runner.promote(vercel);
    ok("Promoted");
  });

  await runner.verify(config, profile);
}

/**
 * `vercel pull/build/deploy` need to know which project they are acting on.
 * Linking writes `.vercel/project.json` in the checkout being deployed, which
 * works for a personal account as well as a team (VERCEL_ORG_ID alone does
 * not, because a personal account's org id is the user id, which this CLI
 * never asks for).
 *
 * `root` is the deployed checkout — the kit, or a satellite's own app folder.
 * Each satellite is its own Vercel project, so each gets its own link file and
 * they cannot be confused for one another.
 */
async function ensureLinked({ vercelJs, config, root, env }: VercelInvocation): Promise<void> {
  if (existsSync(join(root, ".vercel", "project.json"))) return;
  step("Linking the checkout to the Vercel project");
  await runOrThrow(
    process.execPath,
    [
      vercelJs,
      "link",
      "--yes",
      `--project=${config.projectId}`,
      ...(config.teamId ? [`--scope=${config.teamId}`] : []),
    ],
    { cwd: root, env, failureMessage: "vercel link failed" },
  );
}

/**
 * Post-deploy proof, not a claim: probe what is actually serving.
 *
 * The two targets are asked different questions, because "healthy" means
 * different things. The kit is an issuer: it must serve, accept a sign-in
 * attempt, and publish a key. A satellite is a consumer: it must serve, reach
 * its database, and REFUSE a token it cannot verify. Probing a consumer for a
 * published key would report failure on a perfectly healthy deployment, which
 * is how a check stops being read.
 */
async function verify(config: ProjectConfig, profile: DeploymentProfile): Promise<void> {
  heading("Verify");
  step(`Probing ${config.origin}`);

  if (profile.kind === "satellite") {
    const report = await probeConsumer(config.origin);
    for (const line of describeConsumer(report)) info(`  ${line}`);
    await reportSatelliteKeys(config.origin);
    await reportIssuerKeys(profile.issuerOrigin);

    info("");
    if (isConsumerHealthy(report)) ok(`${bold(config.origin)} is healthy.`);
    else
      throw new CliError("The satellite is live but not healthy — see the probe results above.", {
        exitCode: 3,
      });
    return;
  }

  const report = await probe(config.origin);
  for (const line of describe(report)) info(`  ${line}`);

  const keys = await jwksKeyCount(config.origin);
  if (keys === 0) {
    info("");
    warn("The SSO issuer publishes an EMPTY key set: no satellite can verify a handoff.");
    info(`  Set a signing key with ${bold("drk-deploy env:sync")}, then redeploy.`);
  } else if (keys !== null) {
    info(`  ${green("✓")} SSO JWKS publishes ${keys} key(s)`);
  }

  info("");
  if (isHealthy(report)) ok(`${bold(config.origin)} is healthy.`);
  else
    throw new CliError("The deployment is live but not healthy — see the probe results above.", {
      exitCode: 3,
    });
}

/**
 * The inverse of the kit's JWKS check, and the reason it is worth making.
 *
 * A satellite must publish ZERO keys. If it publishes one, it holds
 * `SSO_HANDOFF_PRIVATE_KEY` and has quietly become an issuer the rest of the
 * fleet will trust — which `env:check` catches from the project's variables,
 * but this catches from the RUNNING deployment, including a key set by hand in
 * the dashboard or inherited from an earlier build.
 */
async function reportSatelliteKeys(origin: string): Promise<void> {
  const keys = await jwksKeyCount(origin);
  if (keys === null) return; // no JWKS route, or unreachable — nothing to claim
  if (keys > 0) {
    info("");
    warn(`This satellite PUBLISHES ${keys} signing key(s) — a consumer must publish none.`);
    info(`  It holds SSO_HANDOFF_PRIVATE_KEY and can mint handoff tokens the fleet will trust.`);
    info(`  Remove it with ${bold("drk-deploy env:prune")}, then redeploy.`);
  } else {
    info(`  ${green("✓")} publishes no signing keys (correct for a consumer)`);
  }
}

/**
 * The other half of a consumer's health, and the half it does not control.
 *
 * A satellite verifies every handoff against `${issuer}/api/sso/jwks.json`.
 * Everything about that document is the ISSUER's state — so a satellite can be
 * perfectly configured, pass every probe above, and still reject every handoff
 * because the kit publishes an empty key set or is not reachable from here. It
 * is one GET against the origin the operator just recorded, and it answers the
 * only question the satellite's own probes cannot: "is the thing I was pointed
 * at actually an issuer?"
 *
 * Reported, never fatal: a transient network failure while probing the kit is
 * not a reason to fail a satellite's deploy that has otherwise succeeded.
 */
async function reportIssuerKeys(issuerOrigin: string): Promise<void> {
  const keys = await jwksKeyCount(issuerOrigin);
  if (keys === null) {
    info("");
    warn(`The configured issuer ${issuerOrigin} did not serve /api/sso/jwks.json.`);
    info("  This satellite verifies every handoff against that document — until it is served,");
    info("  every handoff fails here with what looks like a bad signature.");
    return;
  }
  if (keys === 0) {
    info("");
    warn(`The configured issuer ${issuerOrigin} publishes an EMPTY key set.`);
    info(`  Set SSO_HANDOFF_PRIVATE_KEY on the KIT (${bold("drk-deploy env:sync")} there) and redeploy it.`);
    return;
  }
  info(`  ${green("✓")} issuer ${issuerOrigin} publishes ${keys} key(s)`);
}

/**
 * `drk-deploy up` — the whole thing, in order, for someone who does not want
 * to remember the order.
 */
export async function up(
  cliRoot: string,
  options: MigrationOptions & { dryRun?: boolean; yes?: boolean },
  runner: ReleaseRunner = releaseRunner,
): Promise<void> {
  const profile = resolveProfile(requireConfig(cliRoot));
  const migrates = migrationPolicy(profile).allowed;

  heading(profile.kind === "satellite" ? "Deploy a satellite to Vercel" : "Deploy devresponsekit to Vercel");
  info(dim(`  ${describeProfile(profile)}`));
  // The safe order for a deployment that does not own its schema has no
  // migrate step at all — saying so up front beats printing a step that then
  // announces it did nothing.
  info(dim(`  env:sync → pull → ${migrates ? "check target → migrate → " : ""}build → promote → verify`));

  // Before env:sync writes anything to the project: a run that has no
  // migration URL, or a pooled one, stops with production untouched (F-47).
  if (migrates) resolveMigrationUrl({ ...options, satellite: profile.kind === "satellite" });

  await runner.envSync(cliRoot, {
    ...(options.fromEnv !== undefined ? { fromEnv: options.fromEnv } : {}),
    target: "production",
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
  });

  // --from-env is passed on: it can name the migration URL
  // (PRODUCTION_DIRECT_DATABASE_URL) as well as the values env:sync writes.
  await deploy(cliRoot, { ...options, skipChecks: true }, runner); // env:sync just ran; checking again would only repeat itself
}

/** `drk-deploy status` — a short answer to "what is deployed, and is it well?". */
export async function status(cliRoot: string): Promise<void> {
  const config = requireConfig(cliRoot);
  const { VercelClient } = await import("../lib/vercel-client.js");
  const client = new VercelClient(requireToken(), config.teamId);

  const profile = resolveProfile(config);

  heading("Project");
  const project = await client.getProject(config.projectId);
  field("name", `${project.name} ${dim(project.id)}`);
  field("target", describeProfile(profile));
  field("framework", project.framework ?? dim("(unset)"));
  field("origin", config.origin);
  if (profile.kind === "satellite") {
    field("sso issuer", profile.issuerOrigin);
    field("checkout", deployRoot(config));
  }
  field("team", config.teamId ?? dim("(personal account)"));

  heading("Latest production deployment");
  const deployment = await client.latestProductionDeployment(config.projectId);
  if (!deployment) {
    info(dim("  none yet"));
  } else {
    const state = deployment.state === "READY" ? green(deployment.state) : yellow(deployment.state);
    field("state", state);
    field("url", `https://${deployment.url}`);
    if (deployment.createdAt) field("created", new Date(deployment.createdAt).toISOString());
  }

  heading("Health");
  const keys = await jwksKeyCount(config.origin);

  if (profile.kind === "satellite") {
    const consumer = await probeConsumer(config.origin);
    for (const line of describeConsumer(consumer)) info(`  ${line}`);
    // Zero is the correct answer for a consumer, and a non-zero count is the
    // alarming one — the opposite of the kit's reading of the same number.
    field(
      "sso jwks keys",
      keys === null
        ? dim("unreachable")
        : keys === 0
          ? green("0 — correct for a consumer")
          : red(`${keys} — this satellite holds a SIGNING KEY it must not have`),
    );
    // The issuer's key set is the half a consumer cannot fix and cannot see
    // from its own probes: zero keys there means every handoff fails HERE.
    const issuerKeys = await jwksKeyCount(profile.issuerOrigin);
    field(
      "issuer jwks keys",
      issuerKeys === null
        ? yellow(`${profile.issuerOrigin} — no JWKS served`)
        : issuerKeys === 0
          ? red(`0 at ${profile.issuerOrigin} — no handoff can be verified here`)
          : green(`${issuerKeys} at ${profile.issuerOrigin}`),
    );
    return;
  }

  const report = await probe(config.origin);
  for (const line of describe(report)) info(`  ${line}`);
  field(
    "sso jwks keys",
    keys === null
      ? dim("unreachable")
      : keys === 0
        ? red("0 — handoffs cannot be verified")
        : green(String(keys)),
  );
}
