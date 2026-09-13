import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ProjectConfig, requireConfig, requireToken } from "../lib/config.js";
import { runOrThrow } from "../lib/exec.js";
import { probe, describe, isHealthy, jwksKeyCount } from "../lib/health.js";
import { applyMigrations, coreMigrations, ensureKitDependencies } from "../lib/kit.js";
import { CliError, bold, dim, field, green, heading, info, ok, red, step, warn, yellow } from "../lib/log.js";
import { envCheck, envSync } from "./env.js";

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
 */
function resolveMigrationUrl(options: { databaseUrl?: string; allowPooled?: boolean }): string {
  const url =
    options.databaseUrl ??
    process.env.PRODUCTION_DIRECT_DATABASE_URL ??
    process.env.DIRECT_DATABASE_URL ??
    process.env.DATABASE_URL;

  if (!url) {
    throw new CliError("No database URL for migrations.", {
      hint: "Pass --database-url <direct-url>, or set PRODUCTION_DIRECT_DATABASE_URL. Use the DIRECT (non-pooled) endpoint.",
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
  const databaseUrl = resolveMigrationUrl(options);
  const schema = options.schema ?? "auth";

  heading("Database migrations");
  field("kit checkout", config.kitRoot);
  field("schema", schema);
  field("endpoint", dim(redactUrl(databaseUrl)));
  const migrations = coreMigrations(config.kitRoot);
  field("core migrations", `${migrations.length} on disk (${migrations.at(-1) ?? "none"} newest)`);
  info("");

  await ensureKitDependencies(config.kitRoot, options.dryRun ?? false);
  await applyMigrations({ kitRoot: config.kitRoot, databaseUrl, schema, dryRun: options.dryRun ?? false });

  if (!options.dryRun) ok("Migrations applied (idempotent and ledgered — a re-run is a no-op)");
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
): Promise<void> {
  const config = requireConfig(cliRoot);
  const token = requireToken();
  const vercelJs = vercelEntry(cliRoot);

  heading("Preflight");
  if (options.skipChecks) {
    warn("--skip-checks: the environment contract was not verified.");
  } else {
    const problems = await envCheck(cliRoot);
    if (problems > 0 && !options.yes) {
      throw new CliError(`${problems} environment problem(s).`, {
        hint: "Fix with `drk-deploy env:sync`, or re-run with --yes to deploy anyway.",
      });
    }
  }

  if (options.skipMigrations) {
    warn("--skip-migrations: the schema was NOT touched. Only safe when nothing changed.");
  } else {
    await migrate(cliRoot, {
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

  await ensureLinked(vercelJs, config, env);

  step("Pulling production environment and project settings");
  await runOrThrow(process.execPath, [vercelJs, "pull", "--yes", "--environment=production"], {
    cwd: config.kitRoot,
    env,
    failureMessage: "vercel pull failed",
  });

  step("Building");
  await runOrThrow(process.execPath, [vercelJs, "build", "--prod"], {
    cwd: config.kitRoot,
    env,
    failureMessage: "vercel build failed — nothing was promoted",
  });

  step("Promoting the prebuilt output to production");
  await runOrThrow(process.execPath, [vercelJs, "deploy", "--prebuilt", "--prod"], {
    cwd: config.kitRoot,
    env,
    failureMessage: "vercel deploy failed",
  });
  ok("Promoted");

  await verify(config);
}

/**
 * `vercel pull/build/deploy` need to know which project they are acting on.
 * Linking writes `.vercel/project.json` in the kit checkout, which works for a
 * personal account as well as a team (VERCEL_ORG_ID alone does not, because a
 * personal account's org id is the user id, which this CLI never asks for).
 */
async function ensureLinked(
  vercelJs: string,
  config: ProjectConfig,
  env: Record<string, string>,
): Promise<void> {
  if (existsSync(join(config.kitRoot, ".vercel", "project.json"))) return;
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
    { cwd: config.kitRoot, env, failureMessage: "vercel link failed" },
  );
}

/** Post-deploy proof, not a claim: probe what is actually serving. */
async function verify(config: ProjectConfig): Promise<void> {
  heading("Verify");
  step(`Probing ${config.origin}`);
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
): Promise<void> {
  heading("Deploy devresponsekit to Vercel");
  info(dim("  env:sync → migrate → build → promote → verify"));

  await envSync(cliRoot, {
    ...(options.fromEnv !== undefined ? { fromEnv: options.fromEnv } : {}),
    target: "production",
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
  });

  await deploy(cliRoot, {
    ...(options.databaseUrl !== undefined ? { databaseUrl: options.databaseUrl } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.allowPooled !== undefined ? { allowPooled: options.allowPooled } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
    skipChecks: true, // env:sync just ran; checking again would only repeat itself
  });
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

  heading("Project");
  const project = await client.getProject(config.projectId);
  field("name", `${project.name} ${dim(project.id)}`);
  field("framework", project.framework ?? dim("(unset)"));
  field("origin", config.origin);
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
  const report = await probe(config.origin);
  for (const line of describe(report)) info(`  ${line}`);
  const keys = await jwksKeyCount(config.origin);
  field(
    "sso jwks keys",
    keys === null
      ? dim("unreachable")
      : keys === 0
        ? red("0 — handoffs cannot be verified")
        : green(String(keys)),
  );
}
