import { existsSync } from "node:fs";
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
import { type DeploymentProfile, describeProfile, migrationPolicy, resolveProfile } from "../lib/target.js";
import { envCheck, envSync, reportContainment } from "./env.js";

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

/**
 * Resolves the connection string migrations run against.
 *
 * Deliberately separate from the runtime `DATABASE_URL`: a deployment usually
 * runs against a POOLED endpoint, while DDL and the migration runner's advisory
 * lock must use the DIRECT one. Getting this wrong fails in a confusing way
 * (the lock silently does nothing through a transaction pooler), so the pooled
 * shape is refused up front unless explicitly allowed.
 *
 * Exported, with the environment injectable, so this helper's precedence, its
 * satellite branch and the pooled check are table-tested without touching
 * `process.env` (F-45). That `migrate` turns the satellite branch ON is a
 * separate fact, pinned by the tests that call the real `migrate`.
 */
export function resolveMigrationUrl(
  options: {
    databaseUrl?: string;
    allowPooled?: boolean;
    /**
     * A satellite must NAME the database it migrates.
     *
     * The ambient fallbacks below are the kit's: a shell set up to deploy the
     * primary has PRODUCTION_DIRECT_DATABASE_URL pointing at the primary's
     * database. Letting a satellite inherit that would migrate the KIT's
     * database from a satellite's config — the exact confusion this target
     * split exists to prevent — and it would look like it worked, because the
     * migrations are the kit's either way.
     */
    requireExplicit?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = options.requireExplicit
    ? (options.databaseUrl ?? env.SATELLITE_DIRECT_DATABASE_URL)
    : (options.databaseUrl ??
      env.PRODUCTION_DIRECT_DATABASE_URL ??
      env.DIRECT_DATABASE_URL ??
      env.DATABASE_URL);

  if (!url) {
    throw new CliError("No database URL for migrations.", {
      hint: options.requireExplicit
        ? "A satellite must name its own database: pass --database-url <direct-url> (or set SATELLITE_DIRECT_DATABASE_URL). The kit's PRODUCTION_DIRECT_DATABASE_URL is deliberately NOT used here."
        : "Pass --database-url <direct-url>, or set PRODUCTION_DIRECT_DATABASE_URL. Use the DIRECT (non-pooled) endpoint.",
    });
  }
  if (/-pooler\./.test(url) && !options.allowPooled) {
    throw new CliError("That looks like a POOLED connection string (it contains `-pooler`).", {
      hint: "Migrations need the direct endpoint: DDL and the runner's advisory lock do not survive a transaction pooler. Pass --allow-pooled to override.",
    });
  }
  return url;
}

/** `drk-deploy migrate` — apply the kit's migrations to the target database. */
export async function migrate(
  cliRoot: string,
  options: { databaseUrl?: string; schema?: string; allowPooled?: boolean; dryRun?: boolean },
): Promise<void> {
  const config = requireConfig(cliRoot);
  const profile = resolveProfile(config);

  // The guard, before anything is resolved or connected to. There is no
  // --force: a satellite that shares the kit's database does not own its
  // schema, and the escape is to record in the config that it owns its own
  // (see `migrationPolicy`), which is a decision that outlives the session.
  const policy = migrationPolicy(profile);
  if (!policy.allowed) {
    heading("Database migrations");
    field("target", describeProfile(profile));
    info("");
    throw new CliError(policy.why, {
      ...(policy.hint ? { hint: policy.hint } : {}),
      exitCode: 2,
    });
  }

  const isSatellite = profile.kind === "satellite";
  const databaseUrl = resolveMigrationUrl({ ...options, requireExplicit: isSatellite });
  const schema = options.schema ?? "auth";

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
 * Every step `deploy` and `up` put in order, behind one seam (F-45).
 *
 * The order is this CLI's safety property: environment, then migrations, then
 * build and promote, then verify, with nothing after a failure. It used to
 * live only in straight-line calls to functions that spawn `vercel` or open
 * the production database, which no test could run, so a refactor that
 * promoted before migrating, or carried on past a failed migration, passed
 * every check. The commands now reach each step through this interface:
 * {@link releaseRunner} is the real one, and the CLI's tests pass a recording
 * fake and assert the order itself. Anything the two commands do that reaches
 * Vercel, a database or a subprocess belongs here, so a test of the ordering
 * can never reach one.
 */
export interface ReleaseRunner {
  /** `drk-deploy env:sync`. Only `up` runs it. */
  envSync: typeof envSync;
  /** `drk-deploy env:check`, the preflight: the number of problems found. */
  envCheck: typeof envCheck;
  /** `drk-deploy migrate`. */
  migrate: typeof migrate;
  /** `vercel link`, when the checkout has no `.vercel/project.json` yet. */
  link(vercel: VercelInvocation): Promise<void>;
  /** `vercel pull`: the production environment and project settings. */
  pull(vercel: VercelInvocation): Promise<void>;
  /** `vercel build --prod`. */
  build(vercel: VercelInvocation): Promise<void>;
  /** `vercel deploy --prebuilt --prod`: the promotion. */
  promote(vercel: VercelInvocation): Promise<void>;
  /** The post-deploy probes. */
  verify(config: ProjectConfig, profile: DeploymentProfile): Promise<void>;
}

/** The real steps. `deploy` and `up` use these unless a test passes its own. */
export const releaseRunner: ReleaseRunner = {
  envSync,
  envCheck,
  migrate,
  link: ensureLinked,
  pull: (vercel) => runVercel(vercel, ["pull", "--yes", "--environment=production"], "vercel pull failed"),
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
 * `drk-deploy deploy` — migrate, then build, then promote.
 *
 * The order is the whole point. Migrations run BEFORE the new build is
 * promoted, so the currently-live build keeps serving against a schema it
 * understands; promoting first is how you get a live deployment 500ing on
 * every request against a table that does not exist yet. If migrations fail,
 * nothing is promoted.
 */
export async function deploy(
  cliRoot: string,
  options: {
    databaseUrl?: string;
    schema?: string;
    allowPooled?: boolean;
    skipMigrations?: boolean;
    skipChecks?: boolean;
    dryRun?: boolean;
    yes?: boolean;
  },
  runner: ReleaseRunner = releaseRunner,
): Promise<void> {
  const config = requireConfig(cliRoot);
  const token = requireToken();
  const vercelJs = vercelEntry(cliRoot);
  const profile = resolveProfile(config);
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

  heading("Preflight");
  field("target", describeProfile(profile));
  field("checkout", root);
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
        hint: "Fix with `drk-deploy env:sync`, or re-run with --yes to deploy anyway.",
      });
    }
  }

  const policy = migrationPolicy(profile);
  if (options.skipMigrations) {
    warn("--skip-migrations: the schema was NOT touched. Only safe when nothing changed.");
  } else if (!policy.allowed) {
    // Not an error: deploying a satellite that shares the kit's database is
    // an ordinary thing to do. It simply has no migration step, and the safe
    // order for it is env → build → promote → verify.
    heading("Database migrations");
    step("Skipped by policy — this deployment does not own its schema.");
    info(`  ${dim(policy.why)}`);
    if (policy.hint) info(`  ${dim(policy.hint)}`);
  } else {
    await runner.migrate(cliRoot, {
      ...(options.databaseUrl !== undefined ? { databaseUrl: options.databaseUrl } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.allowPooled !== undefined ? { allowPooled: options.allowPooled } : {}),
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    });
  }

  heading("Build and promote");
  // The token travels in the environment, never in argv: an argument list is
  // visible to other processes and lands in shell history.
  const env = {
    VERCEL_TOKEN: token,
    ...(config.teamId ? { VERCEL_ORG_ID: config.teamId } : {}),
    VERCEL_PROJECT_ID: config.projectId,
  };

  if (options.dryRun) {
    step("[dry-run] would run: vercel pull → vercel build --prod → vercel deploy --prebuilt --prod");
    return;
  }

  const vercel: VercelInvocation = { vercelJs, config, root, env };
  await runner.link(vercel);

  step("Pulling production environment and project settings");
  await runner.pull(vercel);

  step("Building");
  await runner.build(vercel);

  step("Promoting the prebuilt output to production");
  await runner.promote(vercel);
  ok("Promoted");

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
  options: {
    fromEnv?: string;
    databaseUrl?: string;
    schema?: string;
    allowPooled?: boolean;
    dryRun?: boolean;
    yes?: boolean;
  },
  runner: ReleaseRunner = releaseRunner,
): Promise<void> {
  const profile = resolveProfile(requireConfig(cliRoot));
  const migrates = migrationPolicy(profile).allowed;

  heading(profile.kind === "satellite" ? "Deploy a satellite to Vercel" : "Deploy devresponsekit to Vercel");
  info(dim(`  ${describeProfile(profile)}`));
  // The safe order for a deployment that does not own its schema has no
  // migrate step at all — saying so up front beats printing a step that then
  // announces it did nothing.
  info(dim(`  env:sync → ${migrates ? "migrate → " : ""}build → promote → verify`));

  await runner.envSync(cliRoot, {
    ...(options.fromEnv !== undefined ? { fromEnv: options.fromEnv } : {}),
    target: "production",
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
  });

  await deploy(
    cliRoot,
    {
      ...(options.databaseUrl !== undefined ? { databaseUrl: options.databaseUrl } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.allowPooled !== undefined ? { allowPooled: options.allowPooled } : {}),
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
      ...(options.yes !== undefined ? { yes: options.yes } : {}),
      skipChecks: true, // env:sync just ran; checking again would only repeat itself
    },
    runner,
  );
}

/** Hides credentials in a connection string before it is printed. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username}:***@` : "";
    return `${parsed.protocol}//${user}${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
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
