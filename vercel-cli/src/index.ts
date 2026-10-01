#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { dbProvision, dbStatus } from "./commands/db.js";
import { doctor } from "./commands/doctor.js";
import { envCheck, envPrune, envSync } from "./commands/env.js";
import { init, login } from "./commands/init.js";
import { deploy, migrateCommand, status, up } from "./commands/release.js";
import { runtimeLogin } from "./commands/runtime-login.js";
import { assertFreshBuild } from "./lib/build-stamp.js";
import { configFileFrom, useConfigFile } from "./lib/config.js";
import { CliError, dim, fail, info, setQuiet, warn } from "./lib/log.js";
import { withRollbackOptions } from "./lib/rollback-options.js";

/** The vercel-cli package root: `dist/index.js` → `..`. */
const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The two overrides of the production-target check (F-47), shared by every
 * command that migrates. Neither covers a DATABASE mismatch: that has no
 * override, because the fix is the right URL.
 */
const ALLOW_UNVERIFIED_TARGET = [
  "--allow-unverified-target",
  "migrate even though production's DATABASE_URL / DATABASE_URL_UNPOOLED (or DB_SCHEMA) cannot be read, e.g. stored sensitive: the target is then NOT checked",
] as const;
const FORCE_SCHEMA = [
  "--force-schema",
  "migrate a --schema that production's DB_SCHEMA does not name",
] as const;

/**
 * The two overrides of the release checks of a command that promotes (F-49).
 * Neither lets a dirty or unpushed checkout through: that has no override,
 * because the fix is a commit and a push.
 */
const ALLOW_REF = [
  "--allow-ref <ref>",
  "promote HEAD when it is this pushed ref (e.g. origin/hotfix) instead of origin's default branch; the tree must still be clean and HEAD pushed. It names the checkout that is built: the kit checkout a satellite's own database is migrated from stays at the kit's default branch",
] as const;
const ALLOW_GIT_INTEGRATION_RACE = [
  "--allow-git-integration-race",
  "migrate and promote even though Vercel's git integration also deploys production on every push, and so can promote a build ahead of its migration",
] as const;

/**
 * The flags that take a secret as an argument (F-143), and where the secret
 * belongs instead. An argument lands in shell history (PSReadLine keeps
 * every line in ConsoleHost_history.txt) and in the process list any local
 * user can read, and from PowerShell cmd.exe re-parses it on the way into
 * `drk-deploy.cmd`, splitting a URL at `&` and dropping `^`. The flags keep
 * working, because scripts use them, but every use is warned about. The
 * warning names the flag, never the value.
 */
const SECRET_FLAGS = [
  {
    option: "token",
    flag: "--token",
    instead:
      "Leave it off to be prompted with the input hidden, pipe the token on stdin, or set VERCEL_TOKEN.",
  },
  {
    option: "databaseUrl",
    flag: "--database-url",
    instead:
      "Set PRODUCTION_DIRECT_DATABASE_URL (a satellite: SATELLITE_DIRECT_DATABASE_URL) in the shell or the --from-env file instead.",
  },
] as const;

const program = new Command();

program
  .name("drk-deploy")
  .description(
    [
      "Deploy devresponsekit — or one of its satellites — to Vercel.",
      "",
      "The short version:",
      "  drk-deploy login            store a Vercel access token",
      "  drk-deploy init             link this checkout to a Vercel project",
      "  drk-deploy up               environment, migrations, build, promote, verify",
      "",
      "Two targets. The KIT issues SSO handoffs and owns the database schema. A",
      "SATELLITE consumes handoffs, holds no signing key, and — unless it owns its",
      "own database — is refused migrations. Configure one with:",
      "  drk-deploy --config .drk-deploy.<name>.json init \\",
      "                  --satellite <standalone|handoff|shared> \\",
      "                  --app-root <path> --issuer <the kit's url>",
      "",
      "One config file per deployment: --config (or DRK_DEPLOY_CONFIG) picks it.",
      // I-14: not every command takes --dry-run. test/unit.test.ts pins this
      // list against the flag each command's --help declares.
      "Every command is safe to re-run (db:runtime-login mints a new login each time).",
      "These also take --dry-run: env:sync, env:prune, db:provision, db:runtime-login,",
      "migrate, deploy and up.",
    ].join("\n"),
  )
  .version("1.0.0")
  .option("-q, --quiet", "only print warnings and errors")
  .option(
    "--config <file>",
    "this deployment's config file (default: DRK_DEPLOY_CONFIG, else .drk-deploy.json); a relative path is beside this CLI, whatever the current directory; one file per deployment",
  )
  .hook("preAction", (thisCommand, actionCommand) => {
    const options = thisCommand.opts<{ quiet?: boolean; config?: string }>();
    setQuiet(Boolean(options.quiet));
    // F-50: each deployment (the kit, each satellite) has its own file, so
    // configuring one never rewrites another's. A relative one is beside the
    // CLI, where the default file is and where .gitignore covers it.
    useConfigFile(configFileFrom(options.config, process.env, CLI_ROOT));
    const given = actionCommand.opts<Record<string, unknown>>();
    for (const secret of SECRET_FLAGS) {
      if (given[secret.option] === undefined) continue;
      warn(
        `${secret.flag} is deprecated: a secret passed as an argument lands in shell history and the process list. ${secret.instead}`,
      );
    }
  });

program
  .command("login")
  .description("Store a Vercel access token (verified before it is saved)")
  .option(
    "--token <token>",
    "deprecated: lands in shell history. Leave it off to be prompted (input hidden), or pipe the token on stdin",
  )
  .action(async (options: { token?: string }) => login(options));

program
  .command("init")
  .description("Link this checkout to a Vercel project and record its settings")
  .option("--project <nameOrId>", "Vercel project name or id")
  .option(
    "--team <teamId>",
    "team id, for a project owned by a team (a personal account needs none: init records the project's owner)",
  )
  .option("--domain <host>", "production domain, e.g. app.example.com")
  .option("--app-name <name>", "product name for NEXT_PUBLIC_APP_NAME")
  .option("--kit-root <path>", "path to the devresponsekit checkout (defaults to the parent directory)")
  .option("--create", "create the project when it does not exist")
  .option("--audience-prefix <prefix>", 'SSO audience prefix (default "devresponse-app")')
  .option("--application-id <id>", "this deployment's SSO application id")
  .option(
    "--satellite <option>",
    "configure a SATELLITE instead of the kit: standalone (A), handoff (B) or shared (C)",
  )
  .option("--app-root <path>", "satellite only: the satellite checkout to build and deploy")
  .option("--issuer <origin>", "satellite only: the KIT's origin, whose JWKS it verifies against")
  .option("--cookie-domain <domain>", "satellite Option C only: the shared parent domain, e.g. .example.com")
  .option("--own-database", "satellite only: this satellite has its OWN database and may be migrated")
  .option("--kit-database", "satellite only: this satellite shares the kit's database (migrations refused)")
  .option("-y, --yes", "do not prompt")
  .action(async (options) => init(CLI_ROOT, options));

program
  .command("doctor")
  .description("Check the toolchain, credentials and project link before deploying")
  .action(async () => {
    const problems = await doctor(CLI_ROOT);
    if (problems > 0) process.exitCode = 1;
  });

program
  .command("status")
  .description("Show the project, its latest production deployment and a live health probe")
  .action(async () => status(CLI_ROOT));

/* ---------------------------------------------------------------- */
/*  Environment                                                      */
/* ---------------------------------------------------------------- */

program
  .command("env:sync")
  .description(
    "Create every variable THIS target needs, generating only the secrets it may (never an Option C session secret, never a satellite signing key)",
  )
  .option("--from-env <file>", "read supplied values (DATABASE_URL, …) from a .env file")
  .option(
    "--target <targets>",
    'production | preview | development | all (default "production"; secrets never go to development)',
  )
  .option("--force", "overwrite variables that already exist (rotates secrets)")
  .option("--dry-run", "show the plan without writing anything")
  .option("-y, --yes", "confirm a rotation")
  .action(async (options) => envSync(CLI_ROOT, options));

program
  .command("env:check")
  .description(
    "Report what production is missing, has wrong, or must not have (public values are read back and verified; secrets are never read)",
  )
  .action(async () => {
    const problems = await envCheck(CLI_ROOT);
    if (problems > 0) process.exitCode = 1;
  });

program
  .command("env:prune")
  .description(
    "Remove variables that must not exist here: the development-only ones, plus a satellite's issuer-only ones (a stray signing key)",
  )
  .option("--dry-run", "show what would be removed")
  .option("-y, --yes", "actually remove them")
  .action(async (options) => envPrune(CLI_ROOT, options));

/* ---------------------------------------------------------------- */
/*  Database                                                         */
/* ---------------------------------------------------------------- */

program
  .command("db:provision")
  .description(
    "Create a marketplace Postgres store and connect it to the project (refused for a deployment that runs on the kit's database)",
  )
  .option("--name <name>", "store name")
  .option("--integration <slugOrId>", "which installed integration to use (default: the first Postgres one)")
  .option("--product <slugOrId>", "which product of that integration")
  .option("--dry-run", "show what would be created")
  .action(async (options) => dbProvision(CLI_ROOT, options));

program
  .command("db:status")
  .description("Show the database variables wired into the project")
  .action(async () => dbStatus(CLI_ROOT));

program
  .command("db:runtime-login")
  .description(
    "Move production onto a NEW least-privilege database login (or retire old ones): checked against the database production's own build names, created and verified through the pooled endpoint by the kit's pnpm db:runtime-login, then DATABASE_URL and DB_SEARCH_PATH_VIA_OPTIONS written to Production, sensitive and never printed",
  )
  .option("--endpoint <pooled|direct>", 'the endpoint the app connects through (default "pooled")')
  .option(
    "--pooled-host <host>",
    "the pooled host for the same database; derived for Neon, required elsewhere",
  )
  .option("--connection-limit <n>", "the login's connection limit (default -1: none)")
  .option(
    "--redeploy",
    "redeploy production afterwards, probe it, and check that its schema gate connects as the new login",
  )
  .option(
    "--plaintext-password",
    "send the password itself instead of a SCRAM verifier, if the server refuses a pre-hashed one",
  )
  .option(
    "--retire-except <login>",
    "retire every rotated login (<schema>_app_<12 digits>) but this one, which must be the one production connects as",
  )
  .option("--retire-all", "retire every rotated login: the break-glass back to the owner")
  .option(
    "--force",
    "with a retire mode: go ahead although production connects as another login, and retire logins with open sessions",
  )
  .option("--schema <name>", 'the schema (default "auth"), checked against the one production\'s gate names')
  .option("--from-env <file>", "read PRODUCTION_DIRECT_DATABASE_URL from a .env file")
  .option(
    "--allow-unverified-target",
    "go ahead when the serving deployment's build log has no [deploy-gate] target line (built before the gate); you then type the database name",
  )
  .option("--dry-run", "show the plan: nothing is created, written or redeployed")
  .option("-y, --yes", "skip typing the database name under --allow-unverified-target")
  .action(async (options) => runtimeLogin(CLI_ROOT, options));

program
  .command("migrate")
  .description(
    "Pull production's settings, check the migration target against them, then apply the kit's migrations (direct endpoint) from a clean, pushed kit checkout: any pushed branch for the kit's own production (a pull request's, before it merges), the kit's default branch for a satellite's own database",
  )
  .option(
    "--database-url <url>",
    "deprecated: lands in shell history. The DIRECT connection string, which belongs in PRODUCTION_DIRECT_DATABASE_URL (shell, then --from-env; never DATABASE_URL). A satellite must NAME its own: SATELLITE_DIRECT_DATABASE_URL or this flag — the kit's variables are deliberately not inherited",
  )
  .option(
    "--from-env <file>",
    "read PRODUCTION_DIRECT_DATABASE_URL (a satellite: SATELLITE_DIRECT_DATABASE_URL) from a .env file",
  )
  .option("--schema <name>", 'target schema (default: production\'s DB_SCHEMA, or "auth" when it sets none)')
  .option(...ALLOW_UNVERIFIED_TARGET)
  .option(...FORCE_SCHEMA)
  .option("--dry-run", "show what would run (production is not pulled, so the target is not checked)")
  .action(async (options) => migrateCommand(CLI_ROOT, options));

/* ---------------------------------------------------------------- */
/*  Release                                                          */
/* ---------------------------------------------------------------- */

const deployCommand = program
  .command("deploy")
  .description(
    "From a clean, pushed checkout at origin's default branch: pull production's settings, migrate (checked against them), build, promote, then verify",
  )
  .option(
    "--database-url <url>",
    "deprecated: lands in shell history. The DIRECT connection string for migrations; set PRODUCTION_DIRECT_DATABASE_URL (a satellite: SATELLITE_DIRECT_DATABASE_URL) instead",
  )
  .option("--from-env <file>", "read the migration URL (PRODUCTION_DIRECT_DATABASE_URL) from a .env file")
  .option("--schema <name>", 'target schema (default: production\'s DB_SCHEMA, or "auth" when it sets none)')
  .option(...ALLOW_UNVERIFIED_TARGET)
  .option(...FORCE_SCHEMA)
  .option(...ALLOW_REF)
  .option(...ALLOW_GIT_INTEGRATION_RACE)
  .option("--skip-migrations", "promote without touching the schema")
  .option("--skip-checks", "skip the environment preflight")
  .option("--dry-run", "show the plan without deploying");
withRollbackOptions(
  deployCommand,
  "proceed despite environment warnings, and roll back a build that fails its probe (unless --no-rollback-on-fail)",
).action(async (options) => deploy(CLI_ROOT, options));

const upCommand = program
  .command("up")
  .description(
    "The whole pipeline: check the commit → env:sync → pull → migrate (checked against production) → build → promote → verify",
  )
  .option(
    "--from-env <file>",
    "read supplied values from a .env file, including the migration URL (PRODUCTION_DIRECT_DATABASE_URL)",
  )
  .option(
    "--database-url <url>",
    "deprecated: lands in shell history. The DIRECT connection string for migrations; set PRODUCTION_DIRECT_DATABASE_URL (a satellite: SATELLITE_DIRECT_DATABASE_URL) instead",
  )
  .option("--schema <name>", 'target schema (default: production\'s DB_SCHEMA, or "auth" when it sets none)')
  .option(...ALLOW_UNVERIFIED_TARGET)
  .option(...FORCE_SCHEMA)
  .option(...ALLOW_REF)
  .option(...ALLOW_GIT_INTEGRATION_RACE)
  .option("--dry-run", "show the plan without changing anything");
withRollbackOptions(
  upCommand,
  "do not stop for confirmations, and roll back a build that fails its probe (unless --no-rollback-on-fail)",
).action(async (options) => up(CLI_ROOT, options));

program.showHelpAfterError("(run `drk-deploy --help` for usage)");

try {
  // I-14: dist/ is gitignored, so a `git pull` never updates it. Refuse to run
  // a build of source that has since changed, before any command (or its
  // --help) is parsed, rather than deploy with the checks it lacks.
  assertFreshBuild(CLI_ROOT);
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CliError) {
    info("");
    fail(err.message);
    if (err.hint) info(`  ${dim(err.hint)}`);
    process.exit(err.exitCode);
  }
  info("");
  fail((err as Error).message ?? String(err));
  if (process.env.DRK_DEPLOY_DEBUG) info(String((err as Error).stack ?? ""));
  else info(`  ${dim("Set DRK_DEPLOY_DEBUG=1 for a stack trace.")}`);
  process.exit(1);
}
