#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { dbProvision, dbStatus } from "./commands/db.js";
import { doctor } from "./commands/doctor.js";
import { envCheck, envPrune, envSync } from "./commands/env.js";
import { init, login } from "./commands/init.js";
import { deploy, migrate, status, up } from "./commands/release.js";
import { CliError, dim, fail, info, setQuiet } from "./lib/log.js";

/** The vercel-cli package root: `dist/index.js` → `..`. */
const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const program = new Command();

program
  .name("drk-deploy")
  .description(
    [
      "Deploy devresponsekit to Vercel.",
      "",
      "The short version:",
      "  drk-deploy login            store a Vercel access token",
      "  drk-deploy init             link this checkout to a Vercel project",
      "  drk-deploy up               environment, migrations, build, promote, verify",
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
  .option("--team <teamId>", "team id, for a project owned by a team")
  .option("--domain <host>", "production domain, e.g. app.example.com")
  .option("--app-name <name>", "product name for NEXT_PUBLIC_APP_NAME")
  .option("--kit-root <path>", "path to the devresponsekit checkout (defaults to the parent directory)")
  .option("--create", "create the project when it does not exist")
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
  .description("Create every variable the kit needs, generating the secrets it can")
  .option("--from-env <file>", "read supplied values (DATABASE_URL, …) from a .env file")
  .option("--target <targets>", 'production | preview | development | all (default "production")')
  .option("--force", "overwrite variables that already exist (rotates secrets)")
  .option("--dry-run", "show the plan without writing anything")
  .option("-y, --yes", "confirm a rotation")
  .action(async (options) => envSync(CLI_ROOT, options));

program
  .command("env:check")
  .description("Report missing, invalid and must-not-be-set variables")
  .action(async () => {
    const problems = await envCheck(CLI_ROOT);
    if (problems > 0) process.exitCode = 1;
  });

program
  .command("env:prune")
  .description("Remove development-only variables that should never exist on a deployment")
  .option("--dry-run", "show what would be removed")
  .option("-y, --yes", "actually remove them")
  .action(async (options) => envPrune(CLI_ROOT, options));

/* ---------------------------------------------------------------- */
/*  Database                                                         */
/* ---------------------------------------------------------------- */

program
  .command("db:provision")
  .description("Create a marketplace Postgres store and connect it to the project")
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
  .description("Apply the kit's migrations to the target database (direct endpoint)")
  .option("--database-url <url>", "the DIRECT connection string (defaults to PRODUCTION_DIRECT_DATABASE_URL)")
  .option("--schema <name>", 'target schema (default "auth")')
  .option("--allow-pooled", "permit a pooled connection string (not recommended)")
  .option("--dry-run", "show what would run")
  .action(async (options) => migrate(CLI_ROOT, options));

/* ---------------------------------------------------------------- */
/*  Release                                                          */
/* ---------------------------------------------------------------- */

program
  .command("deploy")
  .description("Migrate, build, promote to production, then verify")
  .option("--database-url <url>", "the DIRECT connection string for migrations")
  .option("--schema <name>", 'target schema (default "auth")')
  .option("--allow-pooled", "permit a pooled connection string")
  .option("--skip-migrations", "promote without touching the schema")
  .option("--skip-checks", "skip the environment preflight")
  .option("--dry-run", "show the plan without deploying")
  .option("-y, --yes", "proceed despite environment warnings")
  .action(async (options) => deploy(CLI_ROOT, options));

program
  .command("up")
  .description("The whole pipeline: env:sync → migrate → build → promote → verify")
  .option("--from-env <file>", "read supplied values from a .env file")
  .option("--database-url <url>", "the DIRECT connection string for migrations")
  .option("--schema <name>", 'target schema (default "auth")')
  .option("--allow-pooled", "permit a pooled connection string")
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
