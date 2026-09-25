#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { dbProvision, dbStatus } from "./commands/db.js";
import { doctor } from "./commands/doctor.js";
import { envCheck, envPrune, envSync } from "./commands/env.js";
import { init, login } from "./commands/init.js";
import { deploy, migrateCommand, status, up } from "./commands/release.js";
import { CliError, dim, fail, info, setQuiet } from "./lib/log.js";

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
      "  drk-deploy init --satellite <standalone|handoff|shared> \\",
      "                  --app-root <path> --issuer <the kit's url>",
      "",
      "Every command is idempotent and takes --dry-run.",
    ].join("\n"),
  )
  .version("1.0.0")
  .option("-q, --quiet", "only print warnings and errors")
  .hook("preAction", (thisCommand) => {
    setQuiet(Boolean(thisCommand.opts().quiet));
  });

program
  .command("login")
  .description("Store a Vercel access token (verified before it is saved)")
  .option("--token <token>", "the token, instead of being prompted for it")
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
  .option("--target <targets>", 'production | preview | development | all (default "production")')
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
  .command("migrate")
  .description(
    "Pull production's settings, check the migration target against them, then apply the kit's migrations (direct endpoint)",
  )
  .option(
    "--database-url <url>",
    "the DIRECT connection string. Kit: defaults to PRODUCTION_DIRECT_DATABASE_URL (shell, then --from-env), never DATABASE_URL. A satellite must NAME its own: this flag, or SATELLITE_DIRECT_DATABASE_URL — the kit's variables are deliberately not inherited",
  )
  .option(
    "--from-env <file>",
    "read PRODUCTION_DIRECT_DATABASE_URL (a satellite: SATELLITE_DIRECT_DATABASE_URL) from a .env file",
  )
  .option("--schema <name>", 'target schema (default: production\'s DB_SCHEMA, or "auth" when it sets none)')
  .option("--allow-pooled", "permit a pooled connection string (not recommended)")
  .option(...ALLOW_UNVERIFIED_TARGET)
  .option(...FORCE_SCHEMA)
  .option("--dry-run", "show what would run (production is not pulled, so the target is not checked)")
  .action(async (options) => migrateCommand(CLI_ROOT, options));

/* ---------------------------------------------------------------- */
/*  Release                                                          */
/* ---------------------------------------------------------------- */

program
  .command("deploy")
  .description("Pull production's settings, migrate (checked against them), build, promote, then verify")
  .option(
    "--database-url <url>",
    "the DIRECT connection string for migrations (default: PRODUCTION_DIRECT_DATABASE_URL)",
  )
  .option("--from-env <file>", "read the migration URL (PRODUCTION_DIRECT_DATABASE_URL) from a .env file")
  .option("--schema <name>", 'target schema (default: production\'s DB_SCHEMA, or "auth" when it sets none)')
  .option("--allow-pooled", "permit a pooled connection string")
  .option(...ALLOW_UNVERIFIED_TARGET)
  .option(...FORCE_SCHEMA)
  .option("--skip-migrations", "promote without touching the schema")
  .option("--skip-checks", "skip the environment preflight")
  .option("--dry-run", "show the plan without deploying")
  .option("-y, --yes", "proceed despite environment warnings")
  .action(async (options) => deploy(CLI_ROOT, options));

program
  .command("up")
  .description(
    "The whole pipeline: env:sync → pull → migrate (checked against production) → build → promote → verify",
  )
  .option(
    "--from-env <file>",
    "read supplied values from a .env file, including the migration URL (PRODUCTION_DIRECT_DATABASE_URL)",
  )
  .option(
    "--database-url <url>",
    "the DIRECT connection string for migrations (default: PRODUCTION_DIRECT_DATABASE_URL)",
  )
  .option("--schema <name>", 'target schema (default: production\'s DB_SCHEMA, or "auth" when it sets none)')
  .option("--allow-pooled", "permit a pooled connection string")
  .option(...ALLOW_UNVERIFIED_TARGET)
  .option(...FORCE_SCHEMA)
  .option("--dry-run", "show the plan without changing anything")
  .option("-y, --yes", "do not stop for confirmations")
  .action(async (options) => up(CLI_ROOT, options));

program.showHelpAfterError("(run `drk-deploy --help` for usage)");

try {
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
