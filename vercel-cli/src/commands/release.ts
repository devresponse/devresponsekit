import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProjectConfig,
  commandFor,
  configPath,
  deployRoot,
  requireConfig,
  requireToken,
  sameDeploymentInit,
} from "../lib/config.js";
import { runOrThrow } from "../lib/exec.js";
import {
  type PublishedKey,
  probe,
  probeConsumer,
  describe,
  describeConsumer,
  isConsumerHealthy,
  isHealthy,
  jwksKeyCount,
  keysTheIssuerPublishes,
  publishedKeys,
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
import {
  GENERATED_NOTE,
  NEXT_ENV_FILE,
  type ReleaseRule,
  type TreeProblem,
  type TreeState,
  assertRefName,
  describeCommit,
  inspectTree,
  productionAutoDeploy,
  readVercelJson,
  shortSha,
  treeProblems,
} from "../lib/release-tree.js";
import { type DeploymentProfile, describeProfile, migrationPolicy, resolveProfile } from "../lib/target.js";
import type { ProjectGit, ProjectSummary, ServingDeployment } from "../lib/vercel-client.js";
import {
  assertCheckoutLink,
  assertNotIssuerProject,
  issuerProjectProblem,
  projectLinkFile,
  vercelEnvFor,
} from "../lib/vercel-project.js";
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
 * `drk-deploy migrate`: check the kit checkout → link → pull → check the
 * target → migrate, the first half of `deploy`.
 *
 * On its own this command used to migrate whatever URL it resolved, into
 * `auth` unless told otherwise, with nothing to compare either against. It
 * now reads production's settings the way `deploy` does, so a stray URL or a
 * production on another DB_SCHEMA is refused here too (F-47). The guards run
 * first, so a refused migration spawns nothing.
 *
 * The migrations come from the kit checkout, so it must be clean and pushed
 * (F-49). For the kit's own production it may be any pushed branch:
 * docs/deployment.md §1.1 has production migrated from the open pull
 * request's branch before it merges, and this command is how that is done
 * with the target checked. For a satellite's own database it must be the
 * kit's default branch (`releaseSources`): that gate is the kit's, not the
 * satellite's. Nothing here promotes, so the Vercel git integration is not
 * asked about either.
 *
 * A satellite's run also reads the project, before anything is linked or
 * pulled, and refuses the SSO issuer's own (F-50): pulled from the kit's
 * project, "production's database" is the kit's, and a satellite config would
 * then migrate the primary under a satellite's name. The kit's run reads
 * nothing more.
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
  const sources = releaseSources(config, profile, { promotes: false, migrates: true });

  if (options.dryRun) {
    const trees = await assertReleasableTree(runner, sources, { action: "migrate", dryRun: true });
    await dryRunMigration(cliRoot, migration, options, runner, commitOf(trees, config.kitRoot));
    return;
  }

  const vercel = vercelInvocation(cliRoot, config, profile);
  const trees = await assertReleasableTree(runner, sources, { action: "migrate" });
  if (profile.kind === "satellite") {
    assertNotIssuerProject(profile, { project: await runner.project(vercel) });
  }
  await withProductionEnv(vercel, runner, async (production) => {
    const target = checkMigrationTarget(migration, production(), options, commitOf(trees, config.kitRoot));
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
  commit: TreeState | undefined,
): Promise<void> {
  heading("Migration target");
  field("migrating", `${redactUrl(migration.url)} ${dim(`(${migration.source})`)}`);
  if (commit) field("from commit", describeCommit(commit));
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
 *
 * The commit the migrations come from is printed here, next to the database
 * it is applied to (F-49). That line is the record of what ran: the kit's
 * ledger keeps an id, a checksum and a time, and a column for the commit
 * would need a migration of its own.
 */
function checkMigrationTarget(
  migration: MigrationUrl,
  production: Readonly<Record<string, string>>,
  options: MigrationOptions,
  commit: TreeState | undefined,
): MigrationTarget {
  heading("Migration target");
  field("migrating", `${redactUrl(migration.url)} ${dim(`(${migration.source})`)}`);
  if (commit) field("from commit", describeCommit(commit));
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
  /**
   * From `vercelEnvFor`, the only place it is built (F-48): the token, and
   * VERCEL_ORG_ID with VERCEL_PROJECT_ID, both or neither. `undefined`
   * removes the shell's copy from the child.
   */
  env: Record<string, string | undefined>;
  /** The owner `env` names, or null when the checkout's `.vercel/project.json` decides. */
  orgId: string | null;
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
 *
 * `tree`, `project` and `serving` come before anything that writes (F-49,
 * F-50, F-51): before `env:sync`, `vercel link`, the pull and the migration.
 * All three only read. So the order is: [env:check] → tree → project →
 * serving → [env:sync] → link → pull → migrate → build → promote → verify,
 * and on an unhealthy probe with a rollback, → rollback → verify, with
 * nothing after a rollback that failed. `migrate` runs tree → link → pull →
 * migrate, with `project` after `tree` for a satellite.
 */
export interface ReleaseRunner {
  /**
   * The git state of one checkout the run releases from (`inspectTree`):
   * read-only, nothing fetched. `allowRef` replaces origin's default branch
   * as the ref a promoted checkout's HEAD must be.
   */
  tree(root: string, allowRef?: string): Promise<TreeState>;
  /**
   * The project as the Vercel API reports it, read once per run: its git
   * connection (does Vercel deploy production by itself? F-49) and its
   * production aliases (is it the SSO issuer's own project? F-50).
   */
  project(vercel: VercelInvocation): Promise<ProjectSummary>;
  /**
   * The deployment the production origin serves before anything is released
   * (F-51), or null when it serves none yet: what a failed release is rolled
   * back to. Read-only.
   */
  serving(vercel: VercelInvocation): Promise<ServingDeployment | null>;
  /** `drk-deploy env:sync`. Only `up` runs it. */
  envSync: typeof envSync;
  /** `drk-deploy env:check`, the preflight: the number of problems found. */
  envCheck: typeof envCheck;
  /**
   * `vercel link`, when the checkout has no `.vercel/project.json` yet. What
   * it links is checked against the config before `pull` runs (F-48).
   */
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
  /**
   * The post-deploy probes, as a verdict rather than a throw (F-51), so that
   * an unhealthy one can be rolled back and probed again.
   */
  verify(config: ProjectConfig, profile: DeploymentProfile, expect: ProbeExpectations): Promise<Verdict>;
  /**
   * `vercel promote <deployment>`: points production back at the deployment
   * `serving` recorded (F-51, `--rollback-on-fail`). A non-zero exit throws.
   */
  rollback(vercel: VercelInvocation, to: ServingDeployment): Promise<void>;
}

/** What the post-deploy probe found (F-51). */
export interface Verdict {
  healthy: boolean;
  /** Why not, one clause per failed check, for the message that ends the run. */
  problems: string[];
}

/**
 * What the probe holds a deployment to, beyond what it can see for itself.
 *
 * `handoffSigning` is whether production sets `SSO_HANDOFF_PRIVATE_KEY`, from
 * the variables `vercel pull` wrote for this build, or null when they were
 * not read. Only the kit uses it: a kit that signs handoffs and publishes no
 * key fails every satellite's handoff, while a kit that runs no SSO publishes
 * an empty key set by design (the JWKS route always answers).
 */
export interface ProbeExpectations {
  handoffSigning: boolean | null;
}

/**
 * The exit codes of a release whose post-deploy probe failed (F-51). 3 is the
 * one it always had: the new build is live, and no rollback ran. 4 and 5 are
 * the outcomes of a rollback, so a CI step can tell a restored production
 * from one that still needs a person.
 */
export const EXIT_UNHEALTHY = 3;
/** Rolled back: the deployment production served before the run serves again and passes the probe. */
export const EXIT_ROLLED_BACK = 4;
/** The rollback failed, or the deployment it restored fails the probe too: production needs a person. */
export const EXIT_ROLLBACK_FAILED = 5;

/** The real steps. The commands use these unless a test passes its own. */
export const releaseRunner: ReleaseRunner = {
  tree: inspectTree,
  project: async ({ config }) => {
    const { VercelClient } = await import("../lib/vercel-client.js");
    return new VercelClient(requireToken(), config.teamId).getProject(config.projectId);
  },
  serving: async ({ config }) => {
    const { VercelClient } = await import("../lib/vercel-client.js");
    return new VercelClient(requireToken(), config.teamId).servingDeployment(
      new URL(config.origin).hostname,
      config.projectId,
    );
  },
  envSync,
  envCheck,
  link: ensureLinked,
  pull: (vercel) => runVercel(vercel, ["pull", "--yes", "--environment=production"], "vercel pull failed"),
  migrate,
  build: (vercel) => runVercel(vercel, ["build", "--prod"], "vercel build failed — nothing was promoted"),
  promote: (vercel) => runVercel(vercel, ["deploy", "--prebuilt", "--prod"], "vercel deploy failed"),
  verify,
  rollback: (vercel, to) =>
    runVercel(vercel, rollbackArgs(vercel, to), "vercel promote failed — the unhealthy build is still live"),
};

/**
 * Runs the pinned Vercel CLI in the deployed checkout. A non-zero exit throws.
 * The one place a `vercel` child is spawned, always with the invocation's
 * `env` (F-48).
 */
async function runVercel(
  { vercelJs, root, env }: VercelInvocation,
  args: string[],
  failureMessage: string,
): Promise<void> {
  await runOrThrow(process.execPath, [vercelJs, ...args], { cwd: root, env, failureMessage });
}

/**
 * The rollback, as the pinned Vercel CLI takes it (F-51): `vercel promote
 * <deployment id>`, scoped to the project's owner.
 *
 * `promote`, not `vercel rollback`. Both point the production domains back
 * at an existing deployment without rebuilding it, and both wait for Vercel's
 * alias job (3 minutes by default) and exit non-zero when it fails or runs
 * out of time (vercel 59.x, `requestPromote` and `requestRollback`). But after
 * an Instant Rollback Vercel turns OFF the automatic assignment of production
 * domains until a deployment is promoted. The fix released next would then be
 * built and deployed and never go live, and its probe would find the
 * rolled-back build and call it healthy. `promote` leaves that assignment on
 * (it is Vercel's documented way to undo a rollback), and "promote the previous
 * deployment" is how the kit's own docs describe a rollback
 * (docs/deployment.md, "Rollback"). The recorded deployment is a production
 * one, which `promote` re-points rather than rebuilds. `--yes` is never
 * passed: on a preview deployment it would build a NEW production deployment
 * from it instead of asking.
 *
 * `promote` reads the project from the deployment, not from the checkout's
 * link or VERCEL_ORG_ID, and refuses a deployment outside the CLI's current
 * scope. So the recorded owner goes in `--scope`, where the Vercel CLI takes
 * a team id and also a personal account's own id.
 */
function rollbackArgs(vercel: Pick<VercelInvocation, "orgId">, to: ServingDeployment): string[] {
  return ["promote", to.id, ...(vercel.orgId ? [`--scope=${vercel.orgId}`] : [])];
}

/** The rollback as an operator types it, with the recorded deployment filled in (F-51). */
function rollbackCommand(vercel: Pick<VercelInvocation, "orgId">, to: ServingDeployment): string {
  return `vercel ${rollbackArgs(vercel, to).join(" ")}`;
}

/** A recorded deployment, as the operator reads it: its own URL when known, and its id. */
function describeDeployment(deployment: ServingDeployment): string {
  return deployment.url ? `https://${deployment.url} (${deployment.id})` : deployment.id;
}

/**
 * The Vercel CLI invocation for this deployment: the pinned entry point, the
 * checkout, and the environment `vercelEnvFor` builds for it.
 *
 * Everything that would send a `vercel` child to the wrong project is refused
 * here, before any step runs (F-48): a shell VERCEL_PROJECT_ID or
 * VERCEL_ORG_ID that disagrees with the config, and a checkout already linked
 * to another project.
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
    // A satellite's fix names the deployment in full (F-50): `init` refuses a
    // bare new --app-root as another deployment, since another folder is far
    // more often another app than a moved one. The kit has one checkout.
    throw new CliError(`The checkout to deploy does not exist: ${root}`, {
      hint:
        profile.kind === "satellite"
          ? `Re-run \`${sameDeploymentInit({ ...config, satellite: config.satellite! }, "<path-to-the-satellite-checkout>")}\` if the app moved or was re-cloned.`
          : `Re-run \`${commandFor("init --kit-root <path-to-the-kit-checkout>")}\`.`,
    });
  }
  const { env, orgId, ignored } = vercelEnvFor(config, token);
  for (const key of ignored) {
    warn(
      `${key} is set in the shell and NOT passed to vercel: this config records no project owner to check it against.`,
    );
  }
  if (!orgId) {
    // Still deployable: `vercel` then reads the checkout's link, which is
    // checked against the config before and after `vercel link` runs.
    warn(
      `This config records no project owner (written before F-48), so .vercel/project.json picks the project. Re-run \`${commandFor("init")}\` to record it.`,
    );
  }
  assertCheckoutLink(root, config, { required: false });
  return { vercelJs, config, root, env, orgId };
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
 * step never parses them for the migration check. (The kit's run reads one
 * key for its probe, `handoffSigningIn`, where a missing file means unknown,
 * never a refusal.)
 *
 * What `link` linked is checked before `pull` (F-48). With no owner recorded,
 * the link file is the only thing naming the project for `pull`, `build` and
 * `deploy`, so it must exist and name the configured project. A link that went
 * wrong stops the run here, before anything is pulled or migrated.
 */
async function withProductionEnv<T>(
  vercel: VercelInvocation,
  runner: ReleaseRunner,
  body: (production: () => Record<string, string>) => Promise<T>,
): Promise<T> {
  heading("Production settings");
  await runner.link(vercel);
  assertCheckoutLink(vercel.root, vercel.config, { required: vercel.orgId === null });
  const file = pulledEnvFile(vercel.root);
  rmSync(file, { force: true });
  try {
    step("Pulling production environment and project settings (read-only)");
    await runner.pull(vercel);
    return await body(() => readPulledEnv(file));
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Whether production sets `SSO_HANDOFF_PRIVATE_KEY`, from the file `vercel
 * pull` wrote for this build (F-51), or null when it wrote none. A value stored
 * `sensitive` comes back as a placeholder, which still says it is set. Only
 * whether it is set is kept: the value is never printed or returned.
 */
function handoffSigningIn(file: string): boolean | null {
  if (!existsSync(file)) return null;
  const value = parseEnvFile(readFileSync(file, "utf8")).SSO_HANDOFF_PRIVATE_KEY;
  return value !== undefined && value.trim() !== "";
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

/** A checkout a run releases from (F-49), and which HEAD it may be at (`ReleaseRule`). */
interface ReleaseSource {
  label: string;
  root: string;
  rule: ReleaseRule;
}

/**
 * The checkouts a run reads, which are the ones that must be clean and pushed
 * (F-49), and which HEAD each may be at:
 *
 * - The kit's own run: the kit checkout, at the release ref when the run
 *   promotes it, and at any pushed commit for `migrate` (docs/deployment.md
 *   §1.1 migrates the kit's production from the open pull request's branch).
 * - A satellite's run: its app folder when it is built and promoted, at the
 *   release ref, which `--allow-ref` may name. When the satellite owns its
 *   database, the kit checkout its migrations come from as well, at the kit's
 *   default branch, for `migrate` as much as for `deploy` and `up`. The §1.1
 *   gate is the kit's. No document describes migrating a satellite's
 *   production from an unmerged kit branch, and what such a run applies stays
 *   ledgered there under its checksum.
 *
 * A satellite that does not own its database never reads the kit checkout,
 * so the kit's state does not stop its deploy.
 */
function releaseSources(
  config: ProjectConfig,
  profile: DeploymentProfile,
  run: { promotes: boolean; migrates: boolean },
): ReleaseSource[] {
  if (profile.kind !== "satellite") {
    return [{ label: "kit checkout", root: config.kitRoot, rule: run.promotes ? "release" : "any-pushed" }];
  }
  return [
    ...(run.promotes
      ? [{ label: "satellite checkout", root: deployRoot(config), rule: "release" as const }]
      : []),
    ...(run.migrates
      ? [{ label: "kit checkout", root: config.kitRoot, rule: "default-branch" as const }]
      : []),
  ];
}

/** The kit checkout's state among those read, which is where migrations come from. */
function commitOf(trees: TreeState[], kitRoot: string): TreeState | undefined {
  return trees.find((tree) => tree.root === kitRoot);
}

/**
 * Reads every checkout the run releases from, prints the commit each one is
 * at, and refuses the run unless each is releasable (F-49). The rules, and why
 * they are these, are in `lib/release-tree.ts`: a git checkout, a clean tree
 * with untracked files counted, HEAD pushed, and for the checkout a run
 * promotes, HEAD equal to origin's default branch or to `--allow-ref`. The
 * kit checkout behind a satellite's own database must be at the kit's default
 * branch, and `--allow-ref` never reaches it: it names the satellite's ref.
 * A `next-env.d.ts` that a build rewrote is printed as set aside, not refused.
 *
 * It runs before anything writes: before `env:sync`, `vercel link`, the pull
 * and any migration. No flag lets a dirty or unpushed checkout through. The
 * fix is a commit and a push, and anything else would ledger in production a
 * migration no one can look up.
 *
 * A dry run reads and reports the same and refuses nothing: it exists to show
 * what a real run would do, and this is part of that.
 */
async function assertReleasableTree(
  runner: ReleaseRunner,
  sources: ReleaseSource[],
  options: { action: string; allowRef?: string; dryRun?: boolean },
): Promise<TreeState[]> {
  if (options.allowRef !== undefined) assertRefName(options.allowRef);
  const trees: TreeState[] = [];
  const problems: TreeProblem[] = [];
  for (const source of sources) {
    const allowRef = source.rule === "release" ? options.allowRef : undefined;
    const tree = await runner.tree(source.root, allowRef);
    trees.push(tree);
    heading(`Release commit (${source.label})`);
    field("checkout", source.root);
    if (tree.notRepository === null) {
      field("commit", describeCommit(tree));
      for (const path of tree.generated) field("set aside", `${path} ${dim(`(${GENERATED_NOTE})`)}`);
      if (source.rule !== "any-pushed") {
        field(
          "release ref",
          `${tree.release.ref} at ${shortSha(tree.release.commit)} ${dim("(as last fetched: nothing is fetched)")}`,
        );
      }
    }
    problems.push(
      ...treeProblems(tree, {
        label: source.label,
        rule: source.rule,
        ...(allowRef !== undefined ? { allowRef } : {}),
      }),
    );
  }
  if (problems.length === 0) return trees;

  const refusal = new CliError(
    `Refusing to ${options.action}: ${problems.map((problem) => problem.what).join("; ")}. Nothing was changed.`,
    { hint: [...new Set(problems.map((problem) => problem.fix))].join(" "), exitCode: 2 },
  );
  if (!options.dryRun) throw refusal;
  for (const problem of problems) warn(`[dry-run] a real run would refuse: ${problem.what}.`);
  return trees;
}

/**
 * Refuses a run that migrates while Vercel's git integration also deploys
 * production by itself (F-49, `productionAutoDeploy`).
 *
 * The README called that combination a race, and nothing checked it. Vercel
 * promotes every push to the production branch without migrating, so a merge
 * goes live ahead of its migration however soon this runs, and this run's
 * migrate-then-promote order protects nothing. The kit's own production is
 * deployed that way today (docs/deployment.md §1.1). A run with no migrate
 * step has no order to lose, so it is only told. `migrate` never asks: it
 * promotes nothing, and migrating from the pull request's branch before the
 * merge is exactly the gate that path relies on.
 *
 * The git connection comes from the project read {@link readProject} made.
 */
function assertNoAutoDeployRace(
  git: ProjectGit,
  vercel: VercelInvocation,
  options: { migrates: boolean; allowGitIntegrationRace?: boolean; dryRun?: boolean },
): void {
  const verdict = productionAutoDeploy(git, readVercelJson(vercel.root));
  heading("Other deployers");
  field(
    "vercel git integration",
    verdict.on
      ? `${yellow("DEPLOYS PRODUCTION")} ${dim(verdict.why)}`
      : `${green("off")} ${dim(verdict.why)}`,
  );
  if (!verdict.on) return;
  if (!options.migrates) {
    warn(
      "Vercel also deploys production on every push. This run has no migrate step, so that is two deployers of the same code, not a race.",
    );
    return;
  }
  if (options.allowGitIntegrationRace) {
    warn(
      "--allow-git-integration-race: Vercel ALSO promotes every push to production, without migrating. This run's migrate-then-promote order does not stop a merge from going live ahead of its migration.",
    );
    return;
  }
  const branch = git.productionBranch ?? "main";
  const refusal = new CliError(
    `Refusing to deploy: Vercel's git integration also deploys this project's production (${verdict.why}). Nothing was changed.`,
    {
      hint: `Vercel promotes a push without migrating, so this run's migrate-then-promote order cannot hold: a merge goes live ahead of its migration whatever runs here. Turn production auto-deploy off (an Ignored Build Step of \`exit 0\` under Vercel → Project → Settings → Git, or \`"git": { "deploymentEnabled": { "${branch}": false } }\` in vercel.json), or pass --allow-git-integration-race to deploy anyway. \`${commandFor("migrate")}\` is not refused: it promotes nothing, and migrating production from a pull request's branch before it merges is how that path stays safe.`,
      exitCode: 2,
    },
  );
  if (!options.dryRun) throw refusal;
  warn(`[dry-run] a real run would refuse: ${refusal.message}`);
}

/** What `deploy` and `up` settle before anything writes, and `up` hands to `deploy`. */
interface PreparedRelease {
  /** Built, and so checked, before env:sync (F-48). */
  vercel: VercelInvocation;
  /** The checkouts read and found releasable (F-49). */
  trees: TreeState[];
  /**
   * The deployment production served when the run started, which an
   * unhealthy probe rolls back to (F-51). Null when it served none yet (or,
   * in a dry run, could not be read).
   */
  previous: ServingDeployment | null;
}

/** Whether an unhealthy probe is rolled back, and what decided it (F-51). */
interface RollbackPolicy {
  enabled: boolean;
  why: string;
}

/**
 * `--rollback-on-fail` and `--no-rollback-on-fail` decide, and with neither
 * a rollback runs under `--yes` (F-51).
 *
 * `--yes` is how this CLI runs with nobody watching (the README's CI job is
 * `up --yes`), and `deploy --yes` is also how a build gets past a failing
 * environment check, the likeliest way to promote one that then fails its
 * probe. There an exit 3 leaves the broken build serving until someone reads
 * the log. A rollback is safe to do unasked: it re-points the domains at the
 * deployment production served minutes earlier in this same run, which had
 * been serving against the migrated schema since the migrations ran, and
 * reverts nothing in the database (`verifyOrRollBack`). An interactive run
 * without `--yes` keeps the old behaviour and is handed the exact command.
 */
function rollbackPolicy(options: { rollbackOnFail?: boolean; yes?: boolean }): RollbackPolicy {
  if (options.rollbackOnFail === true) return { enabled: true, why: "--rollback-on-fail" };
  if (options.rollbackOnFail === false) return { enabled: false, why: "--no-rollback-on-fail" };
  if (options.yes) {
    return { enabled: true, why: "on by default under --yes; --no-rollback-on-fail turns it off" };
  }
  return { enabled: false, why: "pass --rollback-on-fail (or --yes) to have it run" };
}

/**
 * The project, read once for the checks a run that promotes makes of it
 * (F-49, F-50).
 *
 * A real run that cannot read it stops: neither check can be skipped by an
 * API that is down. A dry run says it could not read it and goes on, because
 * it refuses nothing anyway and a plan with a gap is more use than no plan.
 */
async function readProject(
  runner: ReleaseRunner,
  vercel: VercelInvocation,
  dryRun: boolean | undefined,
): Promise<ProjectSummary | null> {
  try {
    return await runner.project(vercel);
  } catch (err) {
    if (!dryRun) throw err;
    heading("Vercel project");
    warn(
      `[dry-run] could not read the project (${(err as Error).message}), so whether it is the SSO issuer's own project and whether Vercel also deploys production are unknown. A real run reads it before anything writes, and stops if it cannot.`,
    );
    return null;
  }
}

/**
 * The checks of a run that promotes, before anything writes: the commit
 * (F-49), then the project. A satellite config on the SSO issuer's own
 * project is refused (F-50): it would build the satellite and promote it over
 * the primary. That runs here rather than in the environment preflight,
 * because `--yes` and `--skip-checks` skip the preflight, and `up` always
 * does. Then whether Vercel deploys production by itself (F-49). Then, once
 * the run may go ahead, which deployment production serves: what an unhealthy
 * probe rolls back to (F-51).
 */
async function releaseGate(
  runner: ReleaseRunner,
  config: ProjectConfig,
  profile: DeploymentProfile,
  vercel: VercelInvocation,
  options: {
    migrates: boolean;
    rollback: RollbackPolicy;
    allowRef?: string;
    allowGitIntegrationRace?: boolean;
    dryRun?: boolean;
  },
): Promise<{ trees: TreeState[]; previous: ServingDeployment | null }> {
  const trees = await assertReleasableTree(
    runner,
    releaseSources(config, profile, { promotes: true, migrates: options.migrates }),
    {
      action: "deploy",
      ...(options.allowRef !== undefined ? { allowRef: options.allowRef } : {}),
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    },
  );
  const project = await readProject(runner, vercel, options.dryRun);
  if (project !== null) {
    const issuers = issuerProjectProblem(profile, { project });
    if (issuers !== null) {
      heading("Vercel project");
      field("project", `${project.name} ${dim(project.id)}`);
      if (!options.dryRun) assertNotIssuerProject(profile, { project });
      warn(`[dry-run] a real run would refuse: this satellite config points at ${issuers}.`);
    }
    assertNoAutoDeployRace(project.git, vercel, options);
  }
  const previous = await recordRollbackTarget(runner, vercel, options);
  return { trees, previous };
}

/**
 * Records which deployment production serves before anything is released,
 * and prints it with what an unhealthy probe will do about it (F-51).
 *
 * It is read here, with the other checks, before anything writes: once
 * `promote` has run, "the deployment before this one" is a guess. It is the
 * deployment the ORIGIN's host is aliased to (`servingDeployment`), the host
 * the probe requests, and not the project's latest production deployment.
 *
 * A production that serves nothing yet (a first deployment) has nothing to
 * roll back to, which is said and is not an error. One that cannot be read
 * stops a real run, as an unreadable project does (`readProject`), rollback or
 * not: an unhealthy probe would then have no deployment to roll back to or to
 * name, and nothing has been written yet. A dry run says so and goes on.
 */
async function recordRollbackTarget(
  runner: ReleaseRunner,
  vercel: VercelInvocation,
  options: { rollback: RollbackPolicy; dryRun?: boolean },
): Promise<ServingDeployment | null> {
  heading("Rollback target");
  let previous: ServingDeployment | null;
  try {
    previous = await runner.serving(vercel);
  } catch (err) {
    if (!options.dryRun) throw err;
    warn(
      `[dry-run] could not read which deployment ${vercel.config.origin} serves (${(err as Error).message}), so there is no rollback target to show. A real run reads it before anything writes, and stops if it cannot.`,
    );
    return null;
  }
  field(
    "serving now",
    previous ? describeDeployment(previous) : dim("nothing yet: there is no deployment to roll back to"),
  );
  if (previous === null) return null;
  field(
    "if the probe fails",
    options.rollback.enabled
      ? `promote it back ${dim(`(${options.rollback.why})`)}`
      : `the new build stays live, and the command that promotes this one back is printed ${dim(`(${options.rollback.why})`)}`,
  );
  return previous;
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
 *
 * And what is released is a commit: a clean, pushed checkout at origin's
 * default branch (or `--allow-ref`), printed before anything is linked,
 * pulled or migrated (F-49). A project that Vercel also deploys on every push
 * is refused unless `--allow-git-integration-race`, because that push wins
 * the race this order exists for.
 *
 * And a promoted build that fails its probe is not left serving unnamed
 * (F-51): the deployment production served before the run is recorded before
 * anything writes, and is promoted back under `--rollback-on-fail` (the
 * default under `--yes`), or named in the exact command that would do it.
 */
export async function deploy(
  cliRoot: string,
  options: MigrationOptions & {
    skipMigrations?: boolean;
    skipChecks?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    allowRef?: string;
    allowGitIntegrationRace?: boolean;
    rollbackOnFail?: boolean;
  },
  runner: ReleaseRunner = releaseRunner,
  /** Built and checked by `up` before env:sync writes anything (F-48, F-49). */
  prepared?: PreparedRelease,
): Promise<void> {
  const config = requireConfig(cliRoot);
  const profile = resolveProfile(config);
  const vercel = prepared?.vercel ?? vercelInvocation(cliRoot, config, profile);

  heading("Preflight");
  // Which deployment, by its file (F-50): each deployment has its own.
  field("config", configPath(cliRoot));
  field("target", describeProfile(profile));
  field("checkout", vercel.root);
  field(
    "vercel project",
    `${config.projectId} ${dim(vercel.orgId ? `(owner ${vercel.orgId})` : "(no owner recorded: .vercel/project.json decides, checked)")}`,
  );
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
        hint: `Each WRONG line above names its fix, and \`${commandFor("env:sync")}\` fills in what is missing. Or re-run with --yes to deploy anyway.`,
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

  // F-49: the commit, and whether Vercel deploys production by itself, before
  // anything is linked, pulled or migrated, and F-51: what production serves
  // before this run replaces it. `up` settled all three before env:sync.
  const rollback = rollbackPolicy(options);
  const { trees, previous } =
    prepared ??
    (await releaseGate(runner, config, profile, vercel, {
      ...options,
      migrates: migration !== null,
      rollback,
    }));

  if (options.dryRun) {
    if (migration) {
      await dryRunMigration(cliRoot, migration, options, runner, commitOf(trees, config.kitRoot));
    }
    heading("Build and promote");
    step(
      `[dry-run] would run: vercel pull → ${migration ? "check the migration target → migrate → " : ""}vercel build --prod → vercel deploy --prebuilt --prod → verify`,
    );
    if (previous) {
      step(
        `[dry-run] on an unhealthy probe it would ${rollback.enabled ? "run" : "print"}: ${rollbackCommand(vercel, previous)}`,
      );
    }
    return;
  }

  const handoffSigning = await withProductionEnv(vercel, runner, async (production) => {
    if (migration) {
      const target = checkMigrationTarget(migration, production(), options, commitOf(trees, config.kitRoot));
      await runner.migrate(cliRoot, migrationStep(migration, target, options));
    }

    heading("Build and promote");
    step("Building");
    await buildLeavingCheckout(vercel, runner);

    step("Promoting the prebuilt output to production");
    await runner.promote(vercel);
    ok("Promoted");
    // What the probe holds the kit to, from the variables this build read.
    return profile.kind === "satellite" ? null : handoffSigningIn(pulledEnvFile(vercel.root));
  });

  await verifyOrRollBack(runner, config, profile, vercel, {
    previous,
    rollback,
    handoffSigning,
    migrated: migration !== null,
  });
}

/**
 * The end of a release: probe what is serving, and when it is not healthy,
 * put back the deployment production served before the run, or say exactly
 * how (F-51).
 *
 * Before F-51 an unhealthy probe exited 3 and the broken build stayed live
 * until someone found the previous deployment and promoted it by hand. Now:
 *
 * - With no rollback, or nothing to roll back to, it still exits 3, and the
 *   message carries the `vercel promote` command with the recorded
 *   deployment filled in.
 * - With one, `vercel promote` runs, and the origin is probed again. Exit 4:
 *   production serves the previous deployment and it passes. Exit 5: the
 *   rollback failed, or what it restored fails too. Nothing runs after a
 *   rollback that failed, not even the second probe.
 *
 * Rolling back the app after this run migrated the database is safe, and is
 * the kit's documented rollback (docs/deployment.md, "Rollback"): migrations
 * are forward-only and additive, and they run BEFORE the promotion so that
 * the build already serving keeps working against the new schema. The
 * deployment this restores IS that build. It served production against the
 * migrated schema from the moment the migrations finished until the
 * promotion, so the rollback returns production to a state this run had
 * already put it in, and nothing in the database is reverted.
 *
 * The second probe does not hold the kit to `handoffSigning`: a key this run
 * set (`up` generates one) is not in a deployment built before it, which is
 * production as it was, not a failed rollback. A satellite's published key is
 * held against it either way: a consumer holding signing material needs a
 * person whichever build it is.
 */
async function verifyOrRollBack(
  runner: ReleaseRunner,
  config: ProjectConfig,
  profile: DeploymentProfile,
  vercel: VercelInvocation,
  release: {
    previous: ServingDeployment | null;
    rollback: RollbackPolicy;
    handoffSigning: boolean | null;
    migrated: boolean;
  },
): Promise<void> {
  const verdict = await runner.verify(config, profile, { handoffSigning: release.handoffSigning });
  if (verdict.healthy) return;

  const what = profile.kind === "satellite" ? "The satellite" : "The deployment";
  const why = verdict.problems.join("; ");
  const failed = `${what} is live but not healthy: ${why}.`;
  const { previous } = release;
  if (previous === null) {
    throw new CliError(failed, {
      exitCode: EXIT_UNHEALTHY,
      hint: "Production served no earlier deployment this run could record, so there is nothing to roll back to. See the probe results above.",
    });
  }
  const command = rollbackCommand(vercel, previous);
  // Said wherever a rollback is offered or done, because it is the question
  // an operator asks first after a migrating release.
  const schema = release.migrated
    ? " Leave the migrations applied: they are forward-only, and that deployment served against them until the promotion."
    : "";
  // The command is the only way back. A re-run with --rollback-on-fail is
  // not: it records what the origin serves when IT starts, which is this
  // build, so its rollback would promote this build again and blame the
  // environment. The flag is named only for the next release.
  if (!release.rollback.enabled) {
    throw new CliError(failed, {
      exitCode: EXIT_UNHEALTHY,
      hint: `It is still serving. To put back the deployment production served before this run, ${describeDeployment(previous)}, run \`${command}\`. Re-running with --rollback-on-fail would not do it: a new run records this build as the one to roll back to. Pass --rollback-on-fail on later releases to have the rollback done for you.${schema}`,
    });
  }

  heading("Rollback");
  warn(failed);
  step(`Promoting ${describeDeployment(previous)} back to production ${dim(`(${release.rollback.why})`)}`);
  try {
    await runner.rollback(vercel, previous);
  } catch (err) {
    throw new CliError(
      `${failed} The rollback failed as well (${(err as Error).message}), so the unhealthy build is still live.`,
      {
        exitCode: EXIT_ROLLBACK_FAILED,
        hint: `Run it by hand: \`${command}\`, or promote ${describeDeployment(previous)} from the project's Deployments page.`,
      },
    );
  }
  ok("Rolled back");

  const restored = await runner.verify(config, profile, { handoffSigning: null });
  if (!restored.healthy) {
    throw new CliError(
      `The new build failed its probe (${why}) and was rolled back to ${describeDeployment(previous)}, which fails the probe too: ${restored.problems.join("; ")}.`,
      {
        exitCode: EXIT_ROLLBACK_FAILED,
        hint: "Production serves the earlier deployment and is still not healthy, so what fails is not only the new build: look at the environment and the database. See the probe results above.",
      },
    );
  }
  throw new CliError(
    `The new build failed its probe (${why}) and was rolled back: ${describeDeployment(previous)} serves production again and passes the probe.`,
    {
      exitCode: EXIT_ROLLED_BACK,
      hint: `The release failed and is no longer live. Fix it and deploy again.${schema}`,
    },
  );
}

/**
 * `vercel build`, then `next-env.d.ts` put back the way the build found it
 * (F-49).
 *
 * `vercel build` runs `next build` in the checkout, and that rewrites the
 * checkout's `next-env.d.ts` (`rewrittenByBuild` in lib/release-tree.ts): the
 * kit commits the `next dev` form, and the build writes its own. Left alone,
 * every deploy would end with the tracked file modified. The next run sets it
 * aside rather than refusing it, but the operator would still see a change
 * nobody made, and `vercel deploy --prebuilt` would record the promoted build
 * as made from a dirty tree. So the bytes are read before the build and
 * written back after it, whether or not the build succeeded. Nothing reads the
 * file after the build: the promotion uploads `.vercel/output`.
 *
 * A file that was not there before is left alone. Removing it would delete
 * something this run did not have before, which is more than restoring. A
 * restore that fails is a warning: the build output is sound, and the next
 * run sets the file aside.
 */
/**
 * The file's bytes, or null when it does not exist. One read, no separate
 * existence check, so nothing can change between the check and the read.
 */
function readIfPresent(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function buildLeavingCheckout(vercel: VercelInvocation, runner: ReleaseRunner): Promise<void> {
  const file = join(vercel.root, NEXT_ENV_FILE);
  const before = readIfPresent(file);
  try {
    await runner.build(vercel);
  } finally {
    if (before !== null) {
      try {
        const after = readIfPresent(file);
        if (after === null || !after.equals(before)) writeFileSync(file, before);
      } catch (err) {
        warn(
          `Could not put back ${file} after the build (${(err as Error).message}). Restore it with \`git checkout -- ${NEXT_ENV_FILE}\`. The next run sets it aside either way.`,
        );
      }
    }
  }
}

/**
 * Links the deployed checkout to the configured project, writing
 * `.vercel/project.json`, unless it is linked already.
 *
 * `vercel build` reads the project's settings from that file. With an owner
 * recorded, VERCEL_ORG_ID and VERCEL_PROJECT_ID name the project for every
 * step. Without one (a personal-account config written before F-48), the file
 * is what names it, so what this writes is checked before `pull` runs. An
 * existing file was checked before anything ran (`vercelInvocation`).
 *
 * `root` is the deployed checkout — the kit, or a satellite's own app folder.
 * Each satellite is its own Vercel project, so each gets its own link file and
 * they cannot be confused for one another.
 */
async function ensureLinked(vercel: VercelInvocation): Promise<void> {
  if (existsSync(projectLinkFile(vercel.root))) return;
  step("Linking the checkout to the Vercel project");
  const { config } = vercel;
  await runVercel(
    vercel,
    [
      "link",
      "--yes",
      `--project=${config.projectId}`,
      ...(config.teamId ? [`--scope=${config.teamId}`] : []),
    ],
    "vercel link failed",
  );
}

/**
 * Post-deploy proof, not a claim: probe what is actually serving.
 *
 * The two targets are asked different questions, because "healthy" means
 * different things. The kit is an issuer: it must serve, accept a sign-in
 * attempt, and, when production sets a signing key, publish it. A satellite is
 * a consumer: it must serve, reach its database, REFUSE a token it cannot
 * verify, and publish NO key. Probing a consumer for a published key would
 * report failure on a perfectly healthy deployment, which is how a check stops
 * being read.
 *
 * It returns a verdict rather than throwing (F-51), so the release can roll
 * back and probe again. Before F-51 a key problem was only printed: a
 * satellite publishing signing keys, and a kit that sets a signing key but
 * publishes none, both ended "healthy" with exit 0, which is green in CI.
 */
async function verify(
  config: ProjectConfig,
  profile: DeploymentProfile,
  expect: ProbeExpectations,
): Promise<Verdict> {
  heading("Verify");
  step(`Probing ${config.origin}`);
  const problems: string[] = [];

  if (profile.kind === "satellite") {
    const report = await probeConsumer(config.origin);
    for (const line of describeConsumer(report)) info(`  ${line}`);
    if (!isConsumerHealthy(report)) problems.push("its consumer probes fail (see above)");
    const own = await publishedKeys(config.origin);
    const issuer = await publishedKeys(profile.issuerOrigin);
    const keys = reportSatelliteKeys(config, own, issuer);
    if (keys !== null) problems.push(keys);
    reportIssuerKeys(profile.issuerOrigin, issuer);
  } else {
    const report = await probe(config.origin);
    for (const line of describe(report)) info(`  ${line}`);
    if (!isHealthy(report)) problems.push("its health probes fail (see above)");
    const keys = reportKitKeys(await jwksKeyCount(config.origin), expect.handoffSigning);
    if (keys !== null) problems.push(keys);
  }

  info("");
  if (problems.length === 0) ok(`${bold(config.origin)} is healthy.`);
  return { healthy: problems.length === 0, problems };
}

/**
 * The kit's own key set, held to whether production sets a signing key
 * (F-51).
 *
 * The kit's JWKS route always answers, with an EMPTY set when
 * `SSO_HANDOFF_PRIVATE_KEY` is unset, which is right for a kit that runs no
 * SSO. So an empty set fails the probe only when production sets the key:
 * then every satellite's handoff fails verification against this document,
 * with what looks like a bad signature, while the kit itself serves and signs
 * in. Before F-51 that was a warning under "healthy". A set that is not served
 * at all fails the same way. When production's variables were not read,
 * whether it should sign is unknown, and an empty set stays a warning.
 */
function reportKitKeys(keys: number | null, handoffSigning: boolean | null): string | null {
  if (keys !== null && keys > 0) {
    info(`  ${green("✓")} SSO JWKS publishes ${keys} key(s)`);
    return null;
  }
  if (handoffSigning === true) {
    const found = keys === 0 ? "publishes an EMPTY SSO key set" : "does not serve /api/sso/jwks.json";
    info("");
    warn(`The SSO issuer ${found}, although production sets SSO_HANDOFF_PRIVATE_KEY.`);
    info("  Every satellite verifies its handoffs against that document, so every handoff fails.");
    return `it ${found} although production sets SSO_HANDOFF_PRIVATE_KEY`;
  }
  if (keys === 0) {
    info("");
    warn("The SSO issuer publishes an EMPTY key set: no satellite can verify a handoff.");
    info(
      handoffSigning === false
        ? "  Production sets no SSO_HANDOFF_PRIVATE_KEY, which is right only if this deployment issues no handoffs."
        : "  Production's variables were not read, so whether it should sign handoffs is unknown.",
    );
    info(`  Set a signing key with ${bold(commandFor("env:sync"))}, then redeploy.`);
  }
  return null;
}

/**
 * The inverse of the kit's JWKS check, and the reason it is worth making.
 *
 * A satellite must publish ZERO keys. One that publishes a key holds
 * `SSO_HANDOFF_PRIVATE_KEY`, which `env:check` catches from the project's
 * variables and this catches from the RUNNING deployment: a key set by hand in
 * the dashboard, inherited from an earlier build, or deployed past the
 * preflight with `deploy --yes` or `--skip-checks`. Since F-51 it fails the
 * probe, and so the run and, when one is on, triggers a rollback.
 *
 * What the key can do depends on whose it is, so the two cases are told apart
 * by the public key the issuer publishes (`keysTheIssuerPublishes`).
 * Consumers verify a handoff against the ISSUER's key set, selecting the key
 * by `kid` (the kit's jwt-handoff.server.ts), so a key of the satellite's own
 * signs tokens every consumer refuses. The realistic way a key gets here,
 * though, is an environment copied from the kit's, and then it IS the issuer's
 * key: this satellite's `/api/sso/launch` can sign handoffs every consumer
 * accepts, and the kit's private key sits on one more deployment, so it must
 * be rotated on the kit and not only removed here. Either way it is signing
 * material a consumer must not hold.
 *
 * The fix it prints names the project the prune acts on (F-50). A run reaches
 * this only once the project is shown not to be the issuer's (`releaseGate`),
 * and `env:prune` refuses the issuer's project itself, so this never sends
 * anyone to delete the kit's own key.
 *
 * Returns the problem, or null when there is none.
 */
function reportSatelliteKeys(
  config: Pick<ProjectConfig, "origin" | "projectId">,
  own: readonly PublishedKey[] | null,
  issuer: readonly PublishedKey[] | null,
): string | null {
  if (own === null) return null; // no JWKS route, or unreachable — nothing to claim
  if (own.length === 0) {
    info(`  ${green("✓")} publishes no signing keys (correct for a consumer)`);
    return null;
  }
  const theKits = issuer === null ? null : keysTheIssuerPublishes(own, issuer).length > 0;
  info("");
  warn(`This satellite PUBLISHES ${own.length} signing key(s) — a consumer must publish none.`);
  if (theKits === true) {
    info("  It is the KIT's own signing key (the issuer publishes the same public key): this satellite can");
    info(
      "  sign handoffs every consumer accepts, and the kit's private key is exposed on one more deployment.",
    );
    info(
      "  Rotate the kit's SSO_HANDOFF_PRIVATE_KEY as well (docs/configuration.md), with no previous-key overlap.",
    );
  } else if (theKits === false) {
    info(
      "  It is not the kit's key: consumers verify against the issuer's key set, so they refuse what it signs.",
    );
    info("  It is still signing material a consumer must not hold.");
  } else {
    info("  Whether it is the KIT's own key is unknown: the issuer's key set was not served.");
    info("  If this satellite's environment was copied from the kit's, rotate the kit's key as well.");
  }
  info(
    `  Remove it from this satellite's project (${config.projectId}) with ${bold(commandFor("env:prune"))}, then redeploy.`,
  );
  return theKits === true
    ? "it publishes the KIT's own SSO signing key"
    : `it publishes ${own.length} SSO signing key(s), which a consumer must never hold`;
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
 * not a reason to fail a satellite's deploy that has otherwise succeeded, and
 * rolling the satellite back would not fix the kit.
 */
function reportIssuerKeys(issuerOrigin: string, keys: readonly PublishedKey[] | null): void {
  if (keys === null) {
    info("");
    warn(`The configured issuer ${issuerOrigin} did not serve /api/sso/jwks.json.`);
    info("  This satellite verifies every handoff against that document — until it is served,");
    info("  every handoff fails here with what looks like a bad signature.");
    return;
  }
  if (keys.length === 0) {
    info("");
    warn(`The configured issuer ${issuerOrigin} publishes an EMPTY key set.`);
    // Bare on purpose, unlike this deployment's own fixes (F-50): it is run
    // with the KIT's config, which this satellite's --config is not.
    info(`  Set SSO_HANDOFF_PRIVATE_KEY on the KIT (${bold("drk-deploy env:sync")} there) and redeploy it.`);
    return;
  }
  info(`  ${green("✓")} issuer ${issuerOrigin} publishes ${keys.length} key(s)`);
}

/**
 * `drk-deploy up` — the whole thing, in order, for someone who does not want
 * to remember the order.
 */
export async function up(
  cliRoot: string,
  options: MigrationOptions & {
    dryRun?: boolean;
    yes?: boolean;
    allowRef?: string;
    allowGitIntegrationRace?: boolean;
    rollbackOnFail?: boolean;
  },
  runner: ReleaseRunner = releaseRunner,
): Promise<void> {
  const config = requireConfig(cliRoot);
  const profile = resolveProfile(config);
  const migrates = migrationPolicy(profile).allowed;

  heading(profile.kind === "satellite" ? "Deploy a satellite to Vercel" : "Deploy devresponsekit to Vercel");
  info(dim(`  ${describeProfile(profile)}`));
  // The safe order for a deployment that does not own its schema has no
  // migrate step at all — saying so up front beats printing a step that then
  // announces it did nothing.
  info(
    dim(
      `  check the commit → env:sync → pull → ${migrates ? "check target → migrate → " : ""}build → promote → verify`,
    ),
  );

  // Before env:sync writes anything to the project: a run that has no
  // migration URL, or a pooled one, stops with production untouched (F-47).
  if (migrates) resolveMigrationUrl({ ...options, satellite: profile.kind === "satellite" });
  // Likewise a shell naming another Vercel project, or a checkout linked to
  // one (F-48).
  const vercel = vercelInvocation(cliRoot, config, profile);
  // And a checkout that is not a clean, pushed release commit, or a project
  // Vercel deploys by itself on every push (F-49), or, for a satellite, the
  // SSO issuer's own project (F-50). And the deployment production serves
  // now, which a failed probe rolls back to (F-51): read before env:sync, so
  // nothing this run writes can change the answer.
  const { trees, previous } = await releaseGate(runner, config, profile, vercel, {
    ...options,
    migrates,
    rollback: rollbackPolicy(options),
  });

  await runner.envSync(cliRoot, {
    ...(options.fromEnv !== undefined ? { fromEnv: options.fromEnv } : {}),
    target: "production",
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
  });

  // --from-env is passed on: it can name the migration URL
  // (PRODUCTION_DIRECT_DATABASE_URL) as well as the values env:sync writes.
  await deploy(cliRoot, { ...options, skipChecks: true }, runner, { vercel, trees, previous }); // env:sync just ran; checking again would only repeat itself
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
  // Read-only, so said rather than refused: every command that would act on
  // this project refuses it (F-50).
  const issuers = issuerProjectProblem(profile, { project });
  if (issuers !== null) warn(`This satellite config points at the SSO issuer's own project: ${issuers}.`);
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
