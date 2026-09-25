import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { ProjectGit } from "../lib/vercel-client.js";
import { assertCheckoutLink, projectLinkFile, vercelEnvFor } from "../lib/vercel-project.js";
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
 * `tree` and `gitIntegration` come before anything that writes (F-49): before
 * `env:sync`, `vercel link`, the pull and the migration. Both only read. So
 * the order is: [env:check] → tree → git integration → [env:sync] → link →
 * pull → migrate → build → promote → verify. `migrate` runs tree → link →
 * pull → migrate.
 */
export interface ReleaseRunner {
  /**
   * The git state of one checkout the run releases from (`inspectTree`):
   * read-only, nothing fetched. `allowRef` replaces origin's default branch
   * as the ref a promoted checkout's HEAD must be.
   */
  tree(root: string, allowRef?: string): Promise<TreeState>;
  /** The project's git connection, read from the Vercel API: does Vercel deploy production by itself? */
  gitIntegration(vercel: VercelInvocation): Promise<ProjectGit>;
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
  /** The post-deploy probes. */
  verify(config: ProjectConfig, profile: DeploymentProfile): Promise<void>;
}

/** The real steps. The commands use these unless a test passes its own. */
export const releaseRunner: ReleaseRunner = {
  tree: inspectTree,
  gitIntegration: async ({ config }) => {
    const { VercelClient } = await import("../lib/vercel-client.js");
    return (await new VercelClient(requireToken(), config.teamId).getProject(config.projectId)).git;
  },
  envSync,
  envCheck,
  link: ensureLinked,
  pull: (vercel) => runVercel(vercel, ["pull", "--yes", "--environment=production"], "vercel pull failed"),
  migrate,
  build: (vercel) => runVercel(vercel, ["build", "--prod"], "vercel build failed — nothing was promoted"),
  promote: (vercel) => runVercel(vercel, ["deploy", "--prebuilt", "--prod"], "vercel deploy failed"),
  verify,
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
    throw new CliError(`The checkout to deploy does not exist: ${root}`, {
      hint:
        profile.kind === "satellite"
          ? "Re-run `drk-deploy init --app-root <path-to-the-satellite-checkout>`."
          : "Re-run `drk-deploy init --kit-root <path-to-the-kit-checkout>`.",
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
      "This config records no project owner (written before F-48), so .vercel/project.json picks the project. Re-run `drk-deploy init` to record it.",
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
 * step never parses them.
 *
 * What `link` linked is checked before `pull` (F-48). With no owner recorded,
 * the link file is the only thing naming the project for `pull`, `build` and
 * `deploy`, so it must exist and name the configured project. A link that went
 * wrong stops the run here, before anything is pulled or migrated.
 */
async function withProductionEnv(
  vercel: VercelInvocation,
  runner: ReleaseRunner,
  body: (production: () => Record<string, string>) => Promise<void>,
): Promise<void> {
  heading("Production settings");
  await runner.link(vercel);
  assertCheckoutLink(vercel.root, vercel.config, { required: vercel.orgId === null });
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
 * A real run that cannot read the project's git connection stops: this check
 * cannot be skipped by an API that is down. A dry run says it could not read
 * it and goes on, because it refuses nothing anyway and a plan with a gap is
 * more use than no plan.
 */
async function assertNoAutoDeployRace(
  runner: ReleaseRunner,
  vercel: VercelInvocation,
  options: { migrates: boolean; allowGitIntegrationRace?: boolean; dryRun?: boolean },
): Promise<void> {
  let git: ProjectGit;
  try {
    git = await runner.gitIntegration(vercel);
  } catch (err) {
    if (!options.dryRun) throw err;
    heading("Other deployers");
    warn(
      `[dry-run] could not read the project's git connection (${(err as Error).message}), so whether Vercel also deploys production is unknown. A real run reads it before anything writes, and stops if it cannot.`,
    );
    return;
  }
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
      hint: `Vercel promotes a push without migrating, so this run's migrate-then-promote order cannot hold: a merge goes live ahead of its migration whatever runs here. Turn production auto-deploy off (an Ignored Build Step of \`exit 0\` under Vercel → Project → Settings → Git, or \`"git": { "deploymentEnabled": { "${branch}": false } }\` in vercel.json), or pass --allow-git-integration-race to deploy anyway. \`drk-deploy migrate\` is not refused: it promotes nothing, and migrating production from a pull request's branch before it merges is how that path stays safe.`,
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
}

/** The F-49 checks of a run that promotes: the commit, then the other deployer. */
async function releaseGate(
  runner: ReleaseRunner,
  config: ProjectConfig,
  profile: DeploymentProfile,
  vercel: VercelInvocation,
  options: { migrates: boolean; allowRef?: string; allowGitIntegrationRace?: boolean; dryRun?: boolean },
): Promise<TreeState[]> {
  const trees = await assertReleasableTree(
    runner,
    releaseSources(config, profile, { promotes: true, migrates: options.migrates }),
    {
      action: "deploy",
      ...(options.allowRef !== undefined ? { allowRef: options.allowRef } : {}),
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    },
  );
  await assertNoAutoDeployRace(runner, vercel, options);
  return trees;
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
  },
  runner: ReleaseRunner = releaseRunner,
  /** Built and checked by `up` before env:sync writes anything (F-48, F-49). */
  prepared?: PreparedRelease,
): Promise<void> {
  const config = requireConfig(cliRoot);
  const profile = resolveProfile(config);
  const vercel = prepared?.vercel ?? vercelInvocation(cliRoot, config, profile);

  heading("Preflight");
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

  // F-49: the commit, and whether Vercel deploys production by itself, before
  // anything is linked, pulled or migrated. `up` settled both before env:sync.
  const trees =
    prepared?.trees ??
    (await releaseGate(runner, config, profile, vercel, { ...options, migrates: migration !== null }));

  if (options.dryRun) {
    if (migration) {
      await dryRunMigration(cliRoot, migration, options, runner, commitOf(trees, config.kitRoot));
    }
    heading("Build and promote");
    step(
      `[dry-run] would run: vercel pull → ${migration ? "check the migration target → migrate → " : ""}vercel build --prod → vercel deploy --prebuilt --prod`,
    );
    return;
  }

  await withProductionEnv(vercel, runner, async (production) => {
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
  });

  await runner.verify(config, profile);
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
async function buildLeavingCheckout(vercel: VercelInvocation, runner: ReleaseRunner): Promise<void> {
  const file = join(vercel.root, NEXT_ENV_FILE);
  const before = existsSync(file) ? readFileSync(file) : null;
  try {
    await runner.build(vercel);
  } finally {
    if (before !== null) {
      try {
        const after = existsSync(file) ? readFileSync(file) : null;
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
  options: MigrationOptions & {
    dryRun?: boolean;
    yes?: boolean;
    allowRef?: string;
    allowGitIntegrationRace?: boolean;
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
  // Vercel deploys by itself on every push (F-49).
  const trees = await releaseGate(runner, config, profile, vercel, { ...options, migrates });

  await runner.envSync(cliRoot, {
    ...(options.fromEnv !== undefined ? { fromEnv: options.fromEnv } : {}),
    target: "production",
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
  });

  // --from-env is passed on: it can name the migration URL
  // (PRODUCTION_DIRECT_DATABASE_URL) as well as the values env:sync writes.
  await deploy(cliRoot, { ...options, skipChecks: true }, runner, { vercel, trees }); // env:sync just ran; checking again would only repeat itself
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
