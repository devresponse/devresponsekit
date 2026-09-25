import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

// Tests run against the BUILT output, so they exercise exactly what ships.
import { doctor } from "../dist/commands/doctor.js";
import { init } from "../dist/commands/init.js";
import {
  deploy,
  migrate,
  migrateCommand,
  releaseRunner,
  resolveMigrationUrl,
  up,
} from "../dist/commands/release.js";
import { applyMigrations, migrationEnv } from "../dist/lib/kit.js";
import { CliError, setQuiet } from "../dist/lib/log.js";
import { verifyMigrationTarget } from "../dist/lib/migration-target.js";
import { assertCheckoutLink, vercelEnvFor } from "../dist/lib/vercel-project.js";

/* ================================================================== */
/*  F-45 / F-47: the release ORDER, asserted rather than read          */
/* ================================================================== */

/**
 * Every step the commands reach through the runner, in the order `up` runs
 * them. A fake is built from this list, so a step added to the real runner
 * without a fake fails the first test below instead of reaching Vercel or a
 * database from a test.
 */
const STEPS = ["envSync", "envCheck", "link", "pull", "migrate", "build", "promote", "verify"];

/**
 * `deploy` with a preflight, on a target that owns its schema. `pull` comes
 * before `migrate` (F-47): production's variables are what the migration
 * target is checked against.
 */
const KIT_ORDER = ["envCheck", "link", "pull", "migrate", "build", "promote", "verify"];
/** `up`: env:sync replaces the preflight (it would only repeat itself). */
const UP_ORDER = ["envSync", "link", "pull", "migrate", "build", "promote", "verify"];
/** `drk-deploy migrate`: the first half of `deploy`. */
const MIGRATE_ORDER = ["link", "pull", "migrate"];

const TOKEN = "test-token-that-never-leaves-this-process";
/** A personal account's own id, which is what a personal project's `accountId` is. */
const PERSONAL_OWNER = "Xq7personalAccount42";

/** Every variable the release path reads from the shell, scrubbed for the run. */
const AMBIENT = [
  "VERCEL_TOKEN",
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "NOW_ORG_ID",
  "NOW_PROJECT_ID",
  "PRODUCTION_DIRECT_DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "DATABASE_URL",
  "SATELLITE_DIRECT_DATABASE_URL",
];

/*
 * Production, as `vercel pull` delivers it: Neon's pooled DATABASE_URL (with
 * a password, which must never be printed), and the DIRECT URL of the same
 * database that migrations are handed.
 */
const PRODUCTION_POOLED =
  "postgresql://owner:prod-password@ep-quiet-cell-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const PRODUCTION_DIRECT =
  "postgresql://owner:prod-password@ep-quiet-cell-123456.us-east-2.aws.neon.tech/neondb?sslmode=require";
const LOCAL = "postgresql://postgres:postgres@localhost:5432/devresponse";

/** Where the pinned Vercel CLI writes production's variables. Hard-coded: it is Vercel's contract. */
const pulledFile = (root: string) => join(root, ".vercel", ".env.production.local");
/** Where `vercel link` records a checkout's project. Vercel's contract too. */
const linkFile = (root: string) => join(root, ".vercel", "project.json");

let workspace = "";
const savedEnv: Record<string, string | undefined> = {};
const savedFetch = globalThis.fetch;
const offline = (async () => {
  throw new Error("a release test reached the network");
}) as typeof fetch;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "drk-deploy-release-"));
  // The operator's shell may hold real credentials (this CLI is linked to a
  // production project on the machine that develops it). None may reach a
  // test: the token below replaces any stored one, since VERCEL_TOKEN wins.
  for (const key of AMBIENT) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.VERCEL_TOKEN = TOKEN;
  // Every network call belongs to a faked step. One that escapes the runner
  // fails here, loudly, instead of reaching Vercel or a probe target.
  globalThis.fetch = offline;
  setQuiet(true);
});

after(() => {
  setQuiet(false);
  globalThis.fetch = savedFetch;
  for (const key of AMBIENT) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(workspace, { recursive: true, force: true });
});

let fixtures = 0;

/**
 * A throwaway CLI root: its `.drk-deploy.json`, a stub where the pinned Vercel
 * CLI is looked up, and empty checkouts for the kit and a satellite. The stub
 * throws and the kit checkout has no migrations or runner, so a step that
 * escaped the runner fails on the spot rather than deploying or migrating.
 *
 * `database: "own"` records a satellite that owns its database, the one case
 * whose policy lets it migrate. `migratableKit` gives the kit checkout just
 * enough (a package.json with both migrate scripts, a migrations directory,
 * tsx "installed") for a DRY-RUN `migrate` to finish: its scripts exit
 * non-zero, so a run that was not dry still migrates nothing.
 *
 * `owner` is how the config names the project's owner (F-48): `team` (the
 * default) records a team id, `personal` a personal account with the owner
 * `init` now records, and `unrecorded` a personal account configured before
 * it did, with neither.
 */
function fixture(
  target: "kit" | "satellite",
  options: { database?: "own"; migratableKit?: boolean; owner?: "team" | "personal" | "unrecorded" } = {},
): { cliRoot: string; kitRoot: string; appRoot: string } {
  const cliRoot = join(workspace, `cli-${++fixtures}`);
  const kitRoot = join(cliRoot, "kit");
  const appRoot = join(cliRoot, "app");
  const vcDir = join(cliRoot, "node_modules", "vercel", "dist");
  for (const dir of [kitRoot, appRoot, vcDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(vcDir, "vc.js"), 'throw new Error("a release test ran the Vercel CLI");\n');
  if (options.migratableKit) {
    for (const dir of [join(kitRoot, "src", "db", "migrations"), join(kitRoot, "node_modules", "tsx")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(kitRoot, "src", "db", "migrations", "0001-core.sql"), "-- never applied\n");
    const refuse = 'node -e "process.exit(97)"';
    writeFileSync(
      join(kitRoot, "package.json"),
      JSON.stringify({ scripts: { "db:app:migrate": refuse, "db:auth:migrate": refuse } }),
    );
  }

  const owner = options.owner ?? "team";
  const base = {
    projectId: "prj_test",
    ...(owner === "team" ? { teamId: "team_test" } : {}),
    ...(owner === "personal" ? { orgId: PERSONAL_OWNER } : {}),
    origin: "https://demo.example.com",
    appName: "Example",
    audiencePrefix: "devresponse-app",
    applicationId: "portal",
    kitRoot,
  };
  const config =
    target === "kit"
      ? base
      : {
          ...base,
          target: "satellite",
          // With no `database` recorded, the default is the kit's, so there
          // is no migrate step.
          satellite: {
            option: "standalone",
            appRoot,
            issuerOrigin: "https://demo.example.com",
            ...(options.database ? { database: options.database } : {}),
          },
          projectId: "prj_sat",
          origin: "https://app1.example.net",
          applicationId: "standalone",
        };
  writeFileSync(join(cliRoot, ".drk-deploy.json"), JSON.stringify(config));
  return { cliRoot, kitRoot, appRoot };
}

/** A file in the shape `vercel pull` writes: a header, then `KEY="value"` lines. */
function vercelEnvFile(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}="${value}"`);
  return `# Created by Vercel CLI\n${lines.join("\n")}\n`;
}

/**
 * A runner that records each step it is asked to run, and can fail one.
 *
 * Its `pull` does what the real one does to the checkout: it writes
 * `production` (by default, Neon's pooled DATABASE_URL and nothing else) to
 * `.vercel/.env.production.local`, where `vercel pull` puts it. `null` writes
 * nothing. `staleAtPull` records whether a copy was already there when the
 * pull ran, which it must never be. `pulledAtBuild` records whether it was
 * still there when `build` ran, which it must be: the pinned `vercel build`
 * reads production's variables from it, and a missing file is only a debug
 * line there, so a build without them (no NEXT_PUBLIC_* values inlined)
 * would be promoted with every step green.
 *
 * Its `link` does what the pinned `vercel link --project=<id>` does to a
 * checkout that has no link yet (F-48). Handed the pair VERCEL_ORG_ID +
 * VERCEL_PROJECT_ID, it takes the project from them and writes nothing
 * (`setupAndLink` returns before `linkFolderToProject`). Handed neither, it
 * writes `.vercel/project.json` naming the configured project, or with
 * `linked` another project's id, or (`null`) nothing at all. Its `pull`, like
 * the real one, writes that file for the project the pair names.
 */
function recordingRunner(
  options: {
    failAt?: string;
    envProblems?: number;
    production?: Record<string, string> | null;
    linked?: string | null;
  } = {},
) {
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  const seen: { staleAtPull: boolean; pulledAtBuild: boolean | null } = {
    staleAtPull: false,
    pulledAtBuild: null,
  };
  const runner = Object.fromEntries(
    STEPS.map((name) => [
      name,
      async (...received: unknown[]) => {
        calls.push(name);
        args[name] = received;
        if (name === "build") {
          seen.pulledAtBuild = existsSync(pulledFile((received[0] as { root: string }).root));
        }
        // A Vercel step's invocation. Other steps get other arguments, and
        // read none of this.
        const vercel = received[0] as {
          root: string;
          config: { projectId: string };
          env: Record<string, string | undefined>;
        };
        const paired = Boolean(vercel?.env?.VERCEL_ORG_ID && vercel.env.VERCEL_PROJECT_ID);
        if (name === "link" && !paired) {
          const file = linkFile(vercel.root);
          if (!existsSync(file) && options.linked !== null) {
            mkdirSync(join(file, ".."), { recursive: true });
            writeFileSync(
              file,
              JSON.stringify({ projectId: options.linked ?? vercel.config.projectId, orgId: "x" }),
            );
          }
        }
        if (name === "pull" && paired) {
          mkdirSync(join(linkFile(vercel.root), ".."), { recursive: true });
          writeFileSync(
            linkFile(vercel.root),
            JSON.stringify({ projectId: vercel.env.VERCEL_PROJECT_ID, orgId: vercel.env.VERCEL_ORG_ID }),
          );
        }
        if (name === "pull") {
          const file = pulledFile((received[0] as { root: string }).root);
          seen.staleAtPull = existsSync(file);
          const production =
            options.production === undefined ? { DATABASE_URL: PRODUCTION_POOLED } : options.production;
          if (production) {
            mkdirSync(join(file, ".."), { recursive: true });
            writeFileSync(file, vercelEnvFile(production));
          }
        }
        if (options.failAt === name) throw new Error(`${name} failed`);
        return name === "envCheck" ? (options.envProblems ?? 0) : undefined;
      },
    ]),
  );
  return { runner: runner as never, calls, args, seen };
}

/** A rejection that is this CliError, by message and hint. */
const refusal =
  (message: RegExp, hint: RegExp = /./, exitCode?: number) =>
  (err: unknown) =>
    err instanceof CliError &&
    message.test(err.message) &&
    hint.test(err.hint ?? "") &&
    (exitCode === undefined || err.exitCode === exitCode);

test("the recording fake stands in for EVERY real step, so no test can reach Vercel", () => {
  assert.deepEqual(
    Object.keys(releaseRunner).sort(),
    [...STEPS].sort(),
    "a step added to releaseRunner must be added to STEPS, or these tests would run the real one",
  );
});

test("deploy: preflight → link → pull → migrate → build → promote → verify, exactly once each", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const { runner, calls, args, seen } = recordingRunner();
  await deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, schema: "auth" }, runner);
  assert.deepEqual(calls, KIT_ORDER);
  assert.equal(seen.pulledAtBuild, true, "vercel build reads production's variables from the pulled file");

  // What the steps were handed: the migration URL as named and the schema
  // checked against production, and the token in the child's ENVIRONMENT
  // (never argv) for every Vercel call.
  assert.deepEqual(args.migrate, [cliRoot, { databaseUrl: PRODUCTION_DIRECT, schema: "auth" }]);
  for (const name of ["link", "pull", "build", "promote"]) {
    const [invocation] = args[name] as [{ root: string; env: Record<string, string>; vercelJs: string }];
    assert.equal(invocation.root, kitRoot, `${name} runs in the kit checkout`);
    assert.equal(invocation.env.VERCEL_TOKEN, TOKEN, `${name} carries the token in its environment`);
    assert.equal(invocation.env.VERCEL_PROJECT_ID, "prj_test");
    assert.equal(invocation.env.VERCEL_ORG_ID, "team_test");
    assert.equal(invocation.vercelJs, join(cliRoot, "node_modules", "vercel", "dist", "vc.js"));
  }
  assert.equal(existsSync(pulledFile(kitRoot)), false, "production's secrets do not outlive the run");
});

test("deploy: NOTHING runs after a failed step — a failed migration promotes nothing", async () => {
  for (const [index, failing] of KIT_ORDER.entries()) {
    const { cliRoot, kitRoot } = fixture("kit");
    const { runner, calls } = recordingRunner({ failAt: failing });
    await assert.rejects(
      deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
      new RegExp(`^Error: ${failing} failed$`),
    );
    assert.deepEqual(calls, KIT_ORDER.slice(0, index + 1), `after ${failing} failed`);
    assert.equal(
      existsSync(pulledFile(kitRoot)),
      false,
      `the pulled file is removed after ${failing} failed`,
    );
  }
});

test("deploy: an environment problem stops the run before the schema is touched, unless --yes", async () => {
  const stopped = recordingRunner({ envProblems: 2 });
  await assert.rejects(
    deploy(fixture("kit").cliRoot, {}, stopped.runner),
    (err: unknown) => err instanceof CliError && err.message === "2 environment problem(s).",
  );
  assert.deepEqual(stopped.calls, ["envCheck"]);

  const forced = recordingRunner({ envProblems: 2 });
  await deploy(fixture("kit").cliRoot, { yes: true, databaseUrl: PRODUCTION_DIRECT }, forced.runner);
  assert.deepEqual(forced.calls, KIT_ORDER, "--yes deploys anyway, in the same order");
});

test("deploy: the flags that drop a step drop only that step", async () => {
  const url = { databaseUrl: PRODUCTION_DIRECT };
  const cases: [string, Record<string, unknown>, string[]][] = [
    ["--skip-checks", { ...url, skipChecks: true }, KIT_ORDER.filter((s) => s !== "envCheck")],
    ["--skip-migrations", { skipMigrations: true }, KIT_ORDER.filter((s) => s !== "migrate")],
    // A dry run still walks the migration step (in dry-run mode) and stops
    // before anything reaches Vercel, so nothing is pulled or checked.
    ["--dry-run", { ...url, dryRun: true }, ["envCheck", "migrate"]],
  ];
  for (const [flag, options, expected] of cases) {
    const { runner, calls, args } = recordingRunner();
    await deploy(fixture("kit").cliRoot, options, runner);
    assert.deepEqual(calls, expected, flag);
    if (flag === "--dry-run") {
      assert.deepEqual((args.migrate as unknown[])[1], { databaseUrl: PRODUCTION_DIRECT, dryRun: true });
    }
  }
});

test("deploy: a satellite on the kit's database has no migrate step, and deploys its own checkout", async () => {
  const { cliRoot, appRoot } = fixture("satellite");
  const { runner, calls, args, seen } = recordingRunner();
  await deploy(cliRoot, {}, runner);
  assert.deepEqual(
    calls,
    KIT_ORDER.filter((s) => s !== "migrate"),
  );
  assert.equal(seen.pulledAtBuild, true, "its build reads production's variables too");
  assert.equal((args.pull as [{ root: string }])[0].root, appRoot);
  assert.equal((args.verify as [unknown, { kind: string }])[1].kind, "satellite");
  assert.equal(existsSync(pulledFile(appRoot)), false, "removed with no migrate step too");
});

test("a run with no migrate step never reads production's variables, so a pull that wrote no file does not stop it", async () => {
  // `vercel pull` writes the file somewhere else under a repository-level
  // link (`.vercel/repo.json`). That only matters to the migration check, so
  // it is read on demand: parsing it eagerly would refuse every deploy of a
  // satellite on the kit's database, and every --skip-migrations run.
  const noMigrateOrder = KIT_ORDER.filter((s) => s !== "migrate");
  const cases: [string, string, Record<string, unknown>, string[]][] = [
    ["deploy, a satellite on the kit's database", fixture("satellite").cliRoot, {}, noMigrateOrder],
    ["deploy --skip-migrations, the kit", fixture("kit").cliRoot, { skipMigrations: true }, noMigrateOrder],
    [
      "up, a satellite on the kit's database",
      fixture("satellite").cliRoot,
      {},
      UP_ORDER.filter((s) => s !== "migrate"),
    ],
  ];
  for (const [name, cliRoot, options, expected] of cases) {
    const { runner, calls } = recordingRunner({ production: null });
    await (name.startsWith("up") ? up : deploy)(cliRoot, options, runner);
    assert.deepEqual(calls, expected, name);
  }
});

test("up: env:sync → link → pull → migrate → build → promote → verify, and nothing after a failure", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const whole = recordingRunner();
  await up(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, whole.runner);
  assert.deepEqual(whole.calls, UP_ORDER, "env:check is not repeated after env:sync");
  assert.equal((whole.args.envSync as [string, { target: string }])[1].target, "production");
  assert.equal(
    whole.seen.pulledAtBuild,
    true,
    "vercel build reads production's variables from the pulled file",
  );
  assert.equal(existsSync(pulledFile(kitRoot)), false, "and they do not outlive the run");

  for (const [index, failing] of UP_ORDER.entries()) {
    const { runner, calls } = recordingRunner({ failAt: failing });
    await assert.rejects(
      up(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
      new RegExp(`^Error: ${failing} failed$`),
    );
    assert.deepEqual(calls, UP_ORDER.slice(0, index + 1), `after ${failing} failed`);
  }
});

test("migrate (the command): link → pull → migrate, and nothing after a failure", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const whole = recordingRunner({ production: { DATABASE_URL: PRODUCTION_POOLED, DB_SCHEMA: "tenant_a" } });
  await migrateCommand(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, whole.runner);
  assert.deepEqual(whole.calls, MIGRATE_ORDER);
  assert.deepEqual(whole.args.migrate, [cliRoot, { databaseUrl: PRODUCTION_DIRECT, schema: "tenant_a" }]);
  assert.equal(existsSync(pulledFile(kitRoot)), false);

  for (const [index, failing] of MIGRATE_ORDER.entries()) {
    const { runner, calls } = recordingRunner({ failAt: failing });
    await assert.rejects(
      migrateCommand(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
      new RegExp(`^Error: ${failing} failed$`),
    );
    assert.deepEqual(calls, MIGRATE_ORDER.slice(0, index + 1), `after ${failing} failed`);
  }

  // A dry run pulls nothing, so it checks nothing, and says so.
  const dry = recordingRunner();
  await migrateCommand(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, dryRun: true }, dry.runner);
  assert.deepEqual(dry.calls, ["migrate"]);
  assert.deepEqual(dry.args.migrate?.[1], { databaseUrl: PRODUCTION_DIRECT, dryRun: true });
});

/* ================================================================== */
/*  F-47: the migration URL is named, never inherited                  */
/* ================================================================== */

test("F-47: a kit shell with only DATABASE_URL is refused before anything is linked, pulled or migrated", async () => {
  // The recorded scenario: the operator's shell points DATABASE_URL at a
  // local database and sets no PRODUCTION_DIRECT_DATABASE_URL. `up` used to
  // migrate the local database, then promote over an unmigrated production.
  const shell = { DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: LOCAL };
  const refused = refusal(
    /^No database URL for migrations\.$/,
    /PRODUCTION_DIRECT_DATABASE_URL[\s\S]*DIRECT_DATABASE_URL and DATABASE_URL are set but deliberately NOT used \(F-47\)/,
  );

  const deployed = recordingRunner();
  await withEnv(shell, () => assert.rejects(deploy(fixture("kit").cliRoot, {}, deployed.runner), refused));
  assert.deepEqual(deployed.calls, ["envCheck"], "the preflight ran; nothing after it");

  const upped = recordingRunner();
  await withEnv(shell, () => assert.rejects(up(fixture("kit").cliRoot, {}, upped.runner), refused));
  assert.deepEqual(upped.calls, [], "refused before env:sync wrote anything to the project");

  const migrated = recordingRunner();
  await withEnv(shell, () =>
    assert.rejects(migrateCommand(fixture("kit").cliRoot, {}, migrated.runner), refused),
  );
  assert.deepEqual(migrated.calls, []);
});

test("F-47: --from-env names the migration URL; the file's DATABASE_URL never does, and the shell wins", async () => {
  const file = (values: Record<string, string>) => {
    const path = join(workspace, `supplied-${++fixtures}.env`);
    writeFileSync(
      path,
      Object.entries(values)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    );
    return path;
  };

  const named = recordingRunner();
  const both = file({ DATABASE_URL: LOCAL, PRODUCTION_DIRECT_DATABASE_URL: PRODUCTION_DIRECT });
  await up(fixture("kit").cliRoot, { fromEnv: both }, named.runner);
  assert.deepEqual(named.calls, UP_ORDER);
  assert.equal((named.args.migrate?.[1] as { databaseUrl: string }).databaseUrl, PRODUCTION_DIRECT);
  assert.equal(
    (named.args.envSync?.[1] as { fromEnv: string }).fromEnv,
    both,
    "env:sync reads the same file",
  );

  const runtimeOnly = recordingRunner();
  await assert.rejects(
    up(fixture("kit").cliRoot, { fromEnv: file({ DATABASE_URL: LOCAL }) }, runtimeOnly.runner),
    refusal(/^No database URL for migrations\.$/, /the --from-env file/),
  );
  assert.deepEqual(runtimeOnly.calls, []);

  assert.deepEqual(
    resolveMigrationUrl(
      { fromEnv: file({ PRODUCTION_DIRECT_DATABASE_URL: LOCAL }) },
      { PRODUCTION_DIRECT_DATABASE_URL: PRODUCTION_DIRECT },
    ),
    { url: PRODUCTION_DIRECT, source: "PRODUCTION_DIRECT_DATABASE_URL in the shell" },
    "the shell wins over a file, as it does for env:sync",
  );
});

test("F-47: an EMPTY shell value is unset, as it is for env:sync, so the --from-env file still names the URL", async () => {
  // The README's CI step exports `${{ secrets.PRODUCTION_DIRECT_DATABASE_URL }}`,
  // which is an empty string when the secret is not defined. An empty value
  // used to win over the file and refuse with a hint to set the variable in
  // the file, where it already was.
  const file = join(workspace, `supplied-${++fixtures}.env`);
  writeFileSync(
    file,
    `PRODUCTION_DIRECT_DATABASE_URL=${PRODUCTION_DIRECT}\nSATELLITE_DIRECT_DATABASE_URL=${SATELLITE_URL}\n`,
  );
  const cases: [string, Record<string, unknown>, Record<string, string>, { url: string; source: string }][] =
    [
      [
        "kit, empty in the shell",
        { fromEnv: file },
        { PRODUCTION_DIRECT_DATABASE_URL: "" },
        { url: PRODUCTION_DIRECT, source: `PRODUCTION_DIRECT_DATABASE_URL in ${file}` },
      ],
      [
        "kit, whitespace in the shell",
        { fromEnv: file },
        { PRODUCTION_DIRECT_DATABASE_URL: "  " },
        { url: PRODUCTION_DIRECT, source: `PRODUCTION_DIRECT_DATABASE_URL in ${file}` },
      ],
      [
        "satellite, empty in the shell",
        { fromEnv: file, satellite: true },
        { SATELLITE_DIRECT_DATABASE_URL: "" },
        { url: SATELLITE_URL, source: `SATELLITE_DIRECT_DATABASE_URL in ${file}` },
      ],
    ];
  for (const [name, options, env, expected] of cases) {
    assert.deepEqual(resolveMigrationUrl(options, env), expected, name);
  }

  // With no file to fall back to, the refusal says the variable is there but
  // empty, rather than telling the operator to set it.
  assert.throws(
    () => resolveMigrationUrl({}, { PRODUCTION_DIRECT_DATABASE_URL: "" }),
    refusal(
      /^No database URL for migrations\.$/,
      /PRODUCTION_DIRECT_DATABASE_URL is set in the shell but EMPTY/,
    ),
  );
  assert.throws(
    () => resolveMigrationUrl({ databaseUrl: "" }, {}),
    refusal(/^No database URL for migrations\.$/, /--database-url was given an EMPTY value/),
    "an explicit flag is never skipped over, even empty",
  );

  // End to end: `up` migrates the file's URL.
  const { runner, calls, args } = recordingRunner();
  await withEnv({ PRODUCTION_DIRECT_DATABASE_URL: "" }, () =>
    up(fixture("kit").cliRoot, { fromEnv: file }, runner),
  );
  assert.deepEqual(calls, UP_ORDER);
  assert.equal((args.migrate?.[1] as { databaseUrl: string }).databaseUrl, PRODUCTION_DIRECT);
});

const FLAG = "postgresql://flag@flag.example.com/app";
const KIT_SHELL = {
  PRODUCTION_DIRECT_DATABASE_URL: "postgresql://kit@kit-direct.example.com/app",
  DIRECT_DATABASE_URL: "postgresql://direct@direct.example.com/app",
  DATABASE_URL: "postgresql://runtime@runtime.example.com/app",
};
const SATELLITE_URL = "postgresql://sat@satellite.example.com/app";
const POOLED = "postgresql://u@ep-quiet-cell-123456-pooler.us-east-2.aws.neon.tech/app";

test("resolveMigrationUrl: explicit sources only, and a satellite never inherits the kit's database", () => {
  const cases: [string, Record<string, unknown>, Record<string, string>, { url: string; source: string }][] =
    [
      ["kit: --database-url wins", { databaseUrl: FLAG }, KIT_SHELL, { url: FLAG, source: "--database-url" }],
      [
        "kit: then PRODUCTION_DIRECT in the shell",
        {},
        KIT_SHELL,
        {
          url: KIT_SHELL.PRODUCTION_DIRECT_DATABASE_URL,
          source: "PRODUCTION_DIRECT_DATABASE_URL in the shell",
        },
      ],
      [
        "kit: SATELLITE_DIRECT is not a kit variable",
        {},
        { ...KIT_SHELL, SATELLITE_DIRECT_DATABASE_URL: SATELLITE_URL },
        {
          url: KIT_SHELL.PRODUCTION_DIRECT_DATABASE_URL,
          source: "PRODUCTION_DIRECT_DATABASE_URL in the shell",
        },
      ],
      [
        "satellite: SATELLITE_DIRECT, over every kit variable",
        { satellite: true },
        { ...KIT_SHELL, SATELLITE_DIRECT_DATABASE_URL: SATELLITE_URL },
        { url: SATELLITE_URL, source: "SATELLITE_DIRECT_DATABASE_URL in the shell" },
      ],
      [
        "satellite: --database-url wins",
        { satellite: true, databaseUrl: FLAG },
        { SATELLITE_DIRECT_DATABASE_URL: SATELLITE_URL },
        { url: FLAG, source: "--database-url" },
      ],
      [
        "pooled, explicitly allowed",
        { databaseUrl: POOLED, allowPooled: true },
        {},
        { url: POOLED, source: "--database-url" },
      ],
    ];
  for (const [name, options, env, expected] of cases) {
    assert.deepEqual(resolveMigrationUrl(options, env), expected, name);
  }
});

test("resolveMigrationUrl: refuses a missing, inherited, malformed or pooled URL, and says why", () => {
  const cases: [string, Record<string, unknown>, Record<string, string>, (err: unknown) => boolean][] = [
    ["kit, nothing set", {}, {}, refusal(/^No database URL/, /PRODUCTION_DIRECT_DATABASE_URL/)],
    // F-47: the kit's old fallbacks are gone, and the refusal names them.
    [
      "kit, only DIRECT_DATABASE_URL",
      {},
      { DIRECT_DATABASE_URL: KIT_SHELL.DIRECT_DATABASE_URL },
      refusal(/^No database URL/, /DIRECT_DATABASE_URL is set but deliberately NOT used/),
    ],
    [
      "kit, only DATABASE_URL",
      {},
      { DATABASE_URL: KIT_SHELL.DATABASE_URL },
      refusal(/^No database URL/, /DATABASE_URL is set but deliberately NOT used/),
    ],
    // The guard the satellite split exists for: a shell set up to deploy the
    // kit must not hand a satellite the KIT's production database.
    [
      "satellite, only the kit's variables set",
      { satellite: true },
      KIT_SHELL,
      refusal(/^No database URL/, /deliberately NOT used/),
    ],
    ["kit, not a postgres URL", { databaseUrl: "mysql://u@h/db" }, {}, refusal(/not a postgres:\/\//)],
    ["kit, pooled flag", { databaseUrl: POOLED }, {}, refusal(/POOLED/, /--allow-pooled/)],
    [
      "kit, pooled shell variable",
      {},
      { PRODUCTION_DIRECT_DATABASE_URL: POOLED },
      refusal(/POOLED/, /--allow-pooled/),
    ],
    [
      "satellite, pooled",
      { satellite: true },
      { SATELLITE_DIRECT_DATABASE_URL: POOLED },
      refusal(/POOLED/, /--allow-pooled/),
    ],
  ];
  for (const [name, options, env, matches] of cases) {
    assert.throws(() => resolveMigrationUrl(options, env), matches, name);
  }
});

test("F-47: every pooled shape is refused for migrations, not only Neon's `-pooler.`", () => {
  const pooled: [string, string, RegExp][] = [
    ["Neon", "postgresql://u@ep-x-pooler.us-east-2.aws.neon.tech/db", /-pooler/],
    ["Supabase", "postgresql://u@aws-0-us-east-1.pooler.supabase.com:5432/postgres", /\.pooler\./],
    ["port 6543", "postgresql://u@db.example.com:6543/postgres", /6543/],
    ["pgbouncer=true", "postgresql://u@db.example.com/app?pgbouncer=true", /pgbouncer=true/],
    ["pgbouncer=TRUE", "postgres://u@db.example.com/app?sslmode=require&pgbouncer=TRUE", /pgbouncer=true/],
  ];
  for (const [name, url, reason] of pooled) {
    assert.throws(
      () => resolveMigrationUrl({ databaseUrl: url }, {}),
      refusal(/^That looks like a POOLED connection string/),
      name,
    );
    assert.throws(
      () => resolveMigrationUrl({ databaseUrl: url }, {}),
      (err: unknown) => reason.test((err as Error).message),
    );
    assert.equal(
      resolveMigrationUrl({ databaseUrl: url, allowPooled: true }, {}).url,
      url,
      `${name}, allowed`,
    );
  }
  // The direct shapes that must NOT trip it.
  for (const url of [
    PRODUCTION_DIRECT,
    "postgresql://u@db.example.com:5432/app?sslmode=require",
    "postgresql://u@poolerhost.example.com/app",
    "postgresql://u@db.example.com/app?pgbouncer=false",
  ]) {
    assert.equal(resolveMigrationUrl({ databaseUrl: url }, {}).url, url, url);
  }
});

/* ================================================================== */
/*  F-47: the target is production's, checked before anything migrates */
/* ================================================================== */

test("F-47: a migration URL that is not production's database is refused before migrate", async () => {
  const wrong: [string, string][] = [
    ["a local database", LOCAL],
    ["another Neon endpoint", "postgresql://owner@ep-other-cell-999999.us-east-2.aws.neon.tech/neondb"],
    [
      "production's host, another database",
      "postgresql://owner@ep-quiet-cell-123456.us-east-2.aws.neon.tech/other",
    ],
    [
      "production's host as a prefix of another",
      "postgresql://owner@ep-quiet-cell-123456.us-east-2.aws.neon.tech.evil.example/neondb",
    ],
  ];
  const refused = (err: unknown) =>
    refusal(
      /^Refusing to migrate: the migration URL is not production's database\.$/,
      /production DATABASE_URL: postgresql:\/\/owner:\*\*\*@ep-quiet-cell-123456-pooler\.us-east-2\.aws\.neon\.tech\/neondb/,
      2,
    )(err) && !(err as CliError).hint?.includes("prod-password");

  for (const [name, url] of wrong) {
    const { cliRoot, kitRoot } = fixture("kit");
    const { runner, calls } = recordingRunner();
    await assert.rejects(deploy(cliRoot, { databaseUrl: url }, runner), refused, name);
    assert.deepEqual(calls, ["envCheck", "link", "pull"], `${name}: nothing migrated, built or promoted`);
    assert.equal(existsSync(pulledFile(kitRoot)), false, `${name}: the pulled file is removed`);
  }

  // up and the migrate command stop at the same place.
  const upped = recordingRunner();
  await assert.rejects(up(fixture("kit").cliRoot, { databaseUrl: LOCAL }, upped.runner), refused);
  assert.deepEqual(upped.calls, ["envSync", "link", "pull"]);
  const migrated = recordingRunner();
  await assert.rejects(
    migrateCommand(fixture("kit").cliRoot, { databaseUrl: LOCAL }, migrated.runner),
    refused,
  );
  assert.deepEqual(migrated.calls, ["link", "pull"]);

  // No override takes a mismatch through: the fix is the right URL.
  const overridden = recordingRunner();
  await assert.rejects(
    deploy(
      fixture("kit").cliRoot,
      { databaseUrl: LOCAL, allowUnverifiedTarget: true, forceSchema: true },
      overridden.runner,
    ),
    refused,
  );
  assert.deepEqual(overridden.calls, ["envCheck", "link", "pull"]);
});

test("F-47: a satellite that owns its database is checked against ITS production the same way", async () => {
  const owned = { database: "own" } as const;
  const { cliRoot, appRoot } = fixture("satellite", owned);
  const { runner, calls, args } = recordingRunner();
  await assert.rejects(deploy(cliRoot, { databaseUrl: LOCAL }, runner), refusal(/not production's database/));
  assert.deepEqual(calls, ["envCheck", "link", "pull"]);
  assert.equal((args.pull as [{ root: string }])[0].root, appRoot, "its own checkout's pull");

  const matched = recordingRunner();
  await deploy(fixture("satellite", owned).cliRoot, { databaseUrl: PRODUCTION_DIRECT }, matched.runner);
  assert.deepEqual(matched.calls, KIT_ORDER);
});

test("F-47: verifyMigrationTarget matches Neon's pooled host to its direct twin, and nothing looser", () => {
  const matches: [string, Record<string, string>, string, string][] = [
    ["direct vs pooled DATABASE_URL", { DATABASE_URL: PRODUCTION_POOLED }, PRODUCTION_DIRECT, "DATABASE_URL"],
    [
      "pooled vs pooled (with --allow-pooled)",
      { DATABASE_URL: PRODUCTION_POOLED },
      PRODUCTION_POOLED,
      "DATABASE_URL",
    ],
    [
      "hosts are case-insensitive",
      { DATABASE_URL: PRODUCTION_POOLED },
      "postgresql://owner@EP-Quiet-Cell-123456.US-East-2.aws.neon.tech/neondb",
      "DATABASE_URL",
    ],
    [
      "a sensitive DATABASE_URL, a readable DATABASE_URL_UNPOOLED",
      { DATABASE_URL: "[SENSITIVE]", DATABASE_URL_UNPOOLED: PRODUCTION_DIRECT },
      PRODUCTION_DIRECT,
      "DATABASE_URL_UNPOOLED",
    ],
    [
      "a Supabase pooler DATABASE_URL, the direct URL stored as DATABASE_URL_UNPOOLED",
      {
        DATABASE_URL: "postgresql://postgres.ref@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
        DATABASE_URL_UNPOOLED: "postgresql://postgres@db.ref.supabase.co:5432/postgres",
      },
      "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres",
      "DATABASE_URL_UNPOOLED",
    ],
  ];
  for (const [name, production, url, key] of matches) {
    const target = verifyMigrationTarget({ url, production });
    assert.equal(target.matched?.key, key, name);
    assert.deepEqual(target.overrides, [], name);
  }

  // The database name is compared exactly: Postgres names are case-sensitive.
  assert.throws(
    () =>
      verifyMigrationTarget({
        url: "postgresql://owner@ep-quiet-cell-123456.us-east-2.aws.neon.tech/NeonDB",
        production: { DATABASE_URL: PRODUCTION_POOLED },
      }),
    refusal(/not production's database/),
  );
});

test("F-47: the port is part of the database, and Supabase's shared pooler is told apart by the project in the username", () => {
  const SUPAVISOR = "aws-0-us-east-1.pooler.supabase.com";
  const matches: [string, Record<string, string>, string][] = [
    [
      "no port is 5432",
      { DATABASE_URL: PRODUCTION_POOLED },
      "postgresql://owner@ep-quiet-cell-123456.us-east-2.aws.neon.tech:5432/neondb",
    ],
    [
      "a self-hosted cluster on its own port",
      { DATABASE_URL: "postgresql://app@db.example.com:5433/app" },
      "postgresql://owner@db.example.com:5433/app",
    ],
    // One project reached through the shared pooler in session mode (5432,
    // which keeps DDL and advisory locks, so --allow-pooled) and in
    // transaction mode (6543): the port picks the pooling mode, the project
    // in the username is the database.
    [
      "Supabase shared pooler, the same project in both modes",
      { DATABASE_URL: `postgresql://postgres.prodref@${SUPAVISOR}:6543/postgres` },
      `postgresql://postgres.prodref:pw@${SUPAVISOR}:5432/postgres`,
    ],
  ];
  for (const [name, production, url] of matches) {
    assert.equal(verifyMigrationTarget({ url, production }).matched?.key, "DATABASE_URL", name);
  }

  const mismatches: [string, Record<string, string>, string][] = [
    [
      "another cluster on production's host and database name",
      { DATABASE_URL: "postgresql://app@db.example.com/app" },
      "postgresql://owner@db.example.com:5433/app",
    ],
    [
      "Neon on a non-default port",
      { DATABASE_URL: PRODUCTION_POOLED },
      "postgresql://owner@ep-quiet-cell-123456.us-east-2.aws.neon.tech:5433/neondb",
    ],
    // The reviewed scenario: every project in the region shares the host and
    // the `postgres` database, so host and database alone matched ANY of them.
    [
      "Supabase shared pooler, another project in the region",
      { DATABASE_URL: `postgresql://postgres.prodref@${SUPAVISOR}:6543/postgres` },
      `postgresql://postgres.otherref:pw@${SUPAVISOR}:5432/postgres`,
    ],
    [
      "Supabase shared pooler, no project in either username",
      { DATABASE_URL: `postgresql://postgres@${SUPAVISOR}:6543/postgres` },
      `postgresql://postgres:pw@${SUPAVISOR}:6543/postgres`,
    ],
    // A pooler on its own port in front of the same server is a different
    // port: store the direct URL as DATABASE_URL_UNPOOLED (matched below).
    [
      "Supabase dedicated pooler on 6543, the direct URL on 5432",
      { DATABASE_URL: "postgresql://postgres@db.prodref.supabase.co:6543/postgres" },
      "postgresql://postgres:pw@db.prodref.supabase.co:5432/postgres",
    ],
  ];
  for (const [name, production, url] of mismatches) {
    assert.throws(
      () => verifyMigrationTarget({ url, production, allowUnverifiedTarget: true }),
      refusal(
        /^Refusing to migrate: the migration URL is not production's database\.$/,
        /the port \(5432 when none is given\)[\s\S]*the project in the username/,
        2,
      ),
      name,
    );
  }

  assert.equal(
    verifyMigrationTarget({
      url: "postgresql://postgres:pw@db.prodref.supabase.co:5432/postgres",
      production: {
        DATABASE_URL: "postgresql://postgres@db.prodref.supabase.co:6543/postgres",
        DATABASE_URL_UNPOOLED: "postgresql://postgres@db.prodref.supabase.co:5432/postgres",
      },
    }).matched?.key,
    "DATABASE_URL_UNPOOLED",
  );
});

test("F-47: a migration URL whose query re-points the connection is refused", async () => {
  // `pg` honours ?host=, ?port= and ?user= over the URL's own host, port and
  // user, and libpq reads ?hostaddr= and ?dbname= too. The check compares the
  // URL's authority, so any of them would be checked as production and
  // migrate somewhere else.
  const sep = PRODUCTION_DIRECT.includes("?") ? "&" : "?";
  for (const param of [
    "host=localhost",
    "hostaddr=127.0.0.1",
    "port=5433",
    "dbname=other",
    "database=other",
    "user=postgres.otherref",
  ]) {
    const url = `${PRODUCTION_DIRECT}${sep}${param}`;
    const name = param.split("=")[0] as string;
    const repointed = (err: unknown) =>
      err instanceof CliError &&
      /re-points the connection/.test(err.message) &&
      err.message.includes(`\`${name}\``) &&
      !err.message.includes("prod-password") &&
      !(err.hint ?? "").includes("prod-password");
    assert.throws(() => resolveMigrationUrl({ databaseUrl: url }, {}), repointed, `resolve: ${param}`);
    assert.throws(
      () => resolveMigrationUrl({ databaseUrl: url, allowPooled: true }, {}),
      repointed,
      `resolve, --allow-pooled does not cover it: ${param}`,
    );
    assert.throws(
      () =>
        verifyMigrationTarget({
          url,
          production: { DATABASE_URL: PRODUCTION_POOLED },
          allowUnverifiedTarget: true,
        }),
      repointed,
      `verify: ${param}`,
    );
  }

  // Refused before anything is spawned, like every other bad URL.
  const { runner, calls } = recordingRunner();
  await assert.rejects(
    up(fixture("kit").cliRoot, { databaseUrl: `${PRODUCTION_DIRECT}&host=localhost` }, runner),
    /re-points the connection/,
  );
  assert.deepEqual(calls, []);

  // Parameters that do not choose the server are left alone.
  for (const url of [
    PRODUCTION_DIRECT,
    `${PRODUCTION_DIRECT}&channel_binding=require&application_name=drk-deploy&connect_timeout=10`,
  ]) {
    assert.equal(resolveMigrationUrl({ databaseUrl: url }, {}).url, url);
    assert.equal(
      verifyMigrationTarget({ url, production: { DATABASE_URL: PRODUCTION_POOLED } }).matched?.key,
      "DATABASE_URL",
    );
  }
});

test("F-47: the schema defaults to production's DB_SCHEMA, and a --schema it does not read is refused unless --force-schema", async () => {
  const tenant = { DATABASE_URL: PRODUCTION_POOLED, DB_SCHEMA: "tenant_a" };

  // The recorded variant: production runs tenant_a, and the migrations used
  // to land in `auth` because nothing read DB_SCHEMA.
  const defaulted = recordingRunner({ production: tenant });
  await deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, defaulted.runner);
  assert.equal((defaulted.args.migrate?.[1] as { schema: string }).schema, "tenant_a");

  const unset = recordingRunner({ production: { DATABASE_URL: PRODUCTION_POOLED } });
  await deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, unset.runner);
  assert.equal((unset.args.migrate?.[1] as { schema: string }).schema, "auth", "production sets none: auth");

  const same = recordingRunner({ production: tenant });
  await deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, schema: "tenant_a" }, same.runner);
  assert.equal((same.args.migrate?.[1] as { schema: string }).schema, "tenant_a");

  const { cliRoot, kitRoot } = fixture("kit");
  const mismatched = recordingRunner({ production: tenant });
  await assert.rejects(
    deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, schema: "auth" }, mismatched.runner),
    refusal(/^Refusing to migrate schema `auth`: production reads `tenant_a`\.$/, /--force-schema/, 2),
  );
  assert.deepEqual(mismatched.calls, ["envCheck", "link", "pull"]);
  assert.equal(existsSync(pulledFile(kitRoot)), false);

  // --allow-unverified-target is not a schema override: tenant_a was READ.
  const wrongFlag = recordingRunner({ production: tenant });
  await assert.rejects(
    deploy(
      fixture("kit").cliRoot,
      { databaseUrl: PRODUCTION_DIRECT, schema: "auth", allowUnverifiedTarget: true },
      wrongFlag.runner,
    ),
    refusal(/^Refusing to migrate schema `auth`/),
  );

  const forced = recordingRunner({ production: tenant });
  await deploy(
    fixture("kit").cliRoot,
    { databaseUrl: PRODUCTION_DIRECT, schema: "auth", forceSchema: true },
    forced.runner,
  );
  assert.deepEqual(forced.calls, KIT_ORDER);
  assert.equal((forced.args.migrate?.[1] as { schema: string }).schema, "auth");
});

test("F-47: production values that cannot be read are refused, unless --allow-unverified-target", async () => {
  const sensitive = { DATABASE_URL: "[SENSITIVE]" };
  const cannotRead = refusal(
    /^Refusing to migrate: production's database could not be read/,
    /--allow-unverified-target/,
    2,
  );

  const refused = recordingRunner({ production: sensitive });
  await assert.rejects(deploy(fixture("kit").cliRoot, { databaseUrl: LOCAL }, refused.runner), cannotRead);
  assert.deepEqual(refused.calls, ["envCheck", "link", "pull"]);

  const allowed = recordingRunner({ production: sensitive });
  await deploy(
    fixture("kit").cliRoot,
    { databaseUrl: PRODUCTION_DIRECT, allowUnverifiedTarget: true },
    allowed.runner,
  );
  assert.deepEqual(allowed.calls, KIT_ORDER);

  // An unreadable DB_SCHEMA is never guessed: --schema is required, and
  // needs the same override.
  const unknownSchema = { DATABASE_URL: PRODUCTION_POOLED, DB_SCHEMA: "[SENSITIVE]" };
  const schemaUnknown = refusal(/DB_SCHEMA could not be read/, /never guessed/, 2);
  for (const options of [{}, { allowUnverifiedTarget: true }, { schema: "tenant_a" }]) {
    const { runner, calls } = recordingRunner({ production: unknownSchema });
    await assert.rejects(
      deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, ...options }, runner),
      schemaUnknown,
      JSON.stringify(options),
    );
    assert.deepEqual(calls, ["envCheck", "link", "pull"]);
  }
  const named = recordingRunner({ production: unknownSchema });
  await deploy(
    fixture("kit").cliRoot,
    { databaseUrl: PRODUCTION_DIRECT, schema: "tenant_a", allowUnverifiedTarget: true },
    named.runner,
  );
  assert.equal((named.args.migrate?.[1] as { schema: string }).schema, "tenant_a");

  // The override is reported, loudly, as what it skipped.
  const target = verifyMigrationTarget({ url: LOCAL, production: sensitive, allowUnverifiedTarget: true });
  assert.equal(target.matched, null);
  assert.match(target.overrides.join("\n"), /NOT checked against production/);
});

test("F-47: a stale pulled file never vouches for production, and a missing one refuses", async () => {
  // A copy left behind by an earlier run or a manual pull, naming the local
  // database. `vercel pull` KEEPS a local value for a key production stores
  // `sensitive`, so if the copy survived the pull it would match LOCAL.
  const { cliRoot, kitRoot } = fixture("kit");
  mkdirSync(join(kitRoot, ".vercel"), { recursive: true });
  writeFileSync(pulledFile(kitRoot), vercelEnvFile({ DATABASE_URL: LOCAL }));
  const stale = recordingRunner({ production: { DATABASE_URL: "[SENSITIVE]" } });
  await assert.rejects(
    deploy(cliRoot, { databaseUrl: LOCAL }, stale.runner),
    refusal(/production's database could not be read/),
  );
  assert.equal(stale.seen.staleAtPull, false, "the stale copy was deleted before the pull");
  assert.equal(existsSync(pulledFile(kitRoot)), false);

  const nothing = recordingRunner({ production: null });
  await assert.rejects(
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, nothing.runner),
    refusal(
      /^vercel pull wrote no .*\.env\.production\.local, so production's database is unknown/,
      /repo\.json/,
      2,
    ),
  );
  assert.deepEqual(nothing.calls, ["envCheck", "link", "pull"]);
});

/* ================================================================== */
/*  F-48: which project `vercel` acts on                               */
/* ================================================================== */

/** A fixture's config, read back. */
const configOf = (cliRoot: string) => JSON.parse(readFileSync(join(cliRoot, ".drk-deploy.json"), "utf8"));

/**
 * Removed from the child: present in the overlay as `undefined`, which drops
 * the shell's copy (`run` layers the overlay over `process.env`, and spawn
 * skips an undefined value). Absent from the overlay would inherit it.
 */
const removed = (env: Record<string, string | undefined>, key: string) =>
  key in env && env[key] === undefined;

/** The refusal for a shell that names another project than the config. */
const disagrees = (key: string) =>
  refusal(
    /^The shell names a different Vercel project than this config\. Nothing was run\.$/,
    new RegExp(`${key}=`),
    2,
  );

/** The refusal for a checkout whose link names another project. */
const mislinked = (named: string, deploys: string) =>
  refusal(
    new RegExp(
      `^This checkout is linked to another Vercel project: .*project\\.json names ${named}, and this config deploys ${deploys}\\. Nothing was linked, pulled or deployed\\.$`,
    ),
    /delete .*project\.json and re-run[\s\S]*re-run `drk-deploy init`/,
    2,
  );

const COMMANDS = { deploy, up, migrate: migrateCommand } as const;

test("F-48: every vercel child gets VERCEL_PROJECT_ID only together with VERCEL_ORG_ID, or neither", () => {
  const project = { ...configOf(fixture("kit", { owner: "unrecorded" }).cliRoot) };
  const cases: [string, Record<string, unknown>, string | null][] = [
    ["a team", { ...project, teamId: "team_test" }, "team_test"],
    ["a team, owner recorded by init", { ...project, teamId: "team_test", orgId: "team_test" }, "team_test"],
    // The reviewed case: no --team, so VERCEL_PROJECT_ID used to be set with
    // no VERCEL_ORG_ID, and `vercel pull` exited 1 on every run.
    ["a personal account, owner recorded by init", { ...project, orgId: PERSONAL_OWNER }, PERSONAL_OWNER],
    ["a personal account configured before F-48", project, null],
    ["a blank owner is no owner", { ...project, orgId: "  " }, null],
  ];
  for (const [name, config, owner] of cases) {
    const { env, orgId, ignored } = vercelEnvFor(config, TOKEN, {});
    assert.equal(orgId, owner, name);
    assert.equal(env.VERCEL_TOKEN, TOKEN, `${name}: the token travels in the environment`);
    if (owner) {
      assert.equal(env.VERCEL_ORG_ID, owner, name);
      assert.equal(env.VERCEL_PROJECT_ID, "prj_test", name);
    } else {
      // The Vercel CLI then reads the checkout's link, which is checked.
      assert.ok(removed(env, "VERCEL_ORG_ID") && removed(env, "VERCEL_PROJECT_ID"), name);
    }
    assert.equal(
      env.VERCEL_ORG_ID === undefined,
      env.VERCEL_PROJECT_ID === undefined,
      `${name}: both or neither, never the one \`vercel\` refuses`,
    );
    assert.ok(
      removed(env, "NOW_ORG_ID") && removed(env, "NOW_PROJECT_ID"),
      `${name}: the legacy names, which pick a project too, never reach the child`,
    );
    assert.deepEqual(ignored, [], name);
  }
});

test("F-48: a personal account deploys, with the pair when its owner is recorded and through its checked link when not", async () => {
  // The reviewed case first: a personal account configured with no --team.
  for (const owner of ["unrecorded", "personal", "team"] as const) {
    const { cliRoot, kitRoot } = fixture("kit", { owner });
    const { runner, calls, args } = recordingRunner();
    await deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner);
    assert.deepEqual(calls, KIT_ORDER, owner);
    // Every Vercel step is handed exactly what the builder makes, so no step
    // can have built an environment of its own.
    const built = vercelEnvFor(configOf(cliRoot), TOKEN, {});
    for (const name of ["link", "pull", "build", "promote"]) {
      const [invocation] = args[name] as [{ env: Record<string, string | undefined>; orgId: string | null }];
      assert.equal(
        invocation.env.VERCEL_ORG_ID === undefined,
        invocation.env.VERCEL_PROJECT_ID === undefined,
        `${owner}: ${name} gets VERCEL_PROJECT_ID only with VERCEL_ORG_ID, the pair \`vercel\` requires`,
      );
      assert.deepEqual(invocation.env, built.env, `${owner}: ${name}`);
      assert.equal(invocation.orgId, built.orgId, `${owner}: ${name}`);
    }
    // Written by `vercel link` when no owner is recorded, and by `vercel pull`
    // when the pair names the project: either way, the configured one.
    assert.equal(JSON.parse(readFileSync(linkFile(kitRoot), "utf8")).projectId, "prj_test", owner);
  }

  const upped = recordingRunner();
  await up(fixture("kit", { owner: "personal" }).cliRoot, { databaseUrl: PRODUCTION_DIRECT }, upped.runner);
  assert.deepEqual(upped.calls, UP_ORDER);
  const [pulled] = upped.args.pull as [{ env: Record<string, string | undefined> }];
  assert.equal(pulled.env.VERCEL_ORG_ID, PERSONAL_OWNER);
  assert.equal(pulled.env.VERCEL_PROJECT_ID, "prj_test");
});

test("F-48: a shell VERCEL_PROJECT_ID or VERCEL_ORG_ID never reaches vercel, and one that disagrees is refused", async () => {
  const team = configOf(fixture("kit").cliRoot);
  const unrecorded = configOf(fixture("kit", { owner: "unrecorded" }).cliRoot);
  const refused: [string, Record<string, unknown>, Record<string, string>, string][] = [
    ["another project", team, { VERCEL_PROJECT_ID: "prj_kit" }, "VERCEL_PROJECT_ID"],
    ["another owner", team, { VERCEL_ORG_ID: "team_other" }, "VERCEL_ORG_ID"],
    [
      "the legacy spelling, which the Vercel CLI still reads",
      team,
      { NOW_PROJECT_ID: "prj_kit" },
      "NOW_PROJECT_ID",
    ],
    // A project id is checkable with no owner recorded.
    ["another project, no owner recorded", unrecorded, { VERCEL_PROJECT_ID: "prj_kit" }, "VERCEL_PROJECT_ID"],
  ];
  for (const [name, config, shell, key] of refused) {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      assert.throws(
        () => vercelEnvFor(config, TOKEN, shell, platform),
        disagrees(key),
        `${name}, ${platform}`,
      );
    }
  }

  // Another casing is the same variable on Windows, so it is checked there.
  // Elsewhere it is another variable, which `vercel` never reads: scrubbed all
  // the same, but no reason to refuse a deploy or to warn.
  const lower = { vercel_project_id: "prj_kit" };
  assert.throws(() => vercelEnvFor(team, TOKEN, lower, "win32"), disagrees("vercel_project_id"));
  assert.deepEqual(vercelEnvFor(unrecorded, TOKEN, { vercel_org_id: PERSONAL_OWNER }, "win32").ignored, [
    "vercel_org_id",
  ]);
  for (const platform of ["linux", "darwin"] as const) {
    const other = vercelEnvFor(team, TOKEN, lower, platform);
    assert.ok(removed(other.env, "vercel_project_id"), platform);
    assert.equal(other.env.VERCEL_PROJECT_ID, "prj_test", platform);
    assert.deepEqual(
      vercelEnvFor(unrecorded, TOKEN, { vercel_org_id: PERSONAL_OWNER }, platform).ignored,
      [],
      platform,
    );
  }

  // Values that agree are not refused, and are still replaced, however spelled.
  const agreed = vercelEnvFor(team, TOKEN, {
    vercel_org_id: "team_test",
    VERCEL_PROJECT_ID: "prj_test",
    NOW_ORG_ID: "",
  });
  assert.equal(agreed.env.VERCEL_ORG_ID, "team_test");
  assert.equal(agreed.env.VERCEL_PROJECT_ID, "prj_test");
  assert.ok(removed(agreed.env, "vercel_org_id") && removed(agreed.env, "NOW_ORG_ID"));
  assert.doesNotThrow(
    () => vercelEnvFor(team, TOKEN, { VERCEL_PROJECT_ID: "", VERCEL_ORG_ID: "  " }),
    "blank is unset",
  );

  // The old workaround for this bug, an exported VERCEL_ORG_ID, cannot be
  // checked against a config with no owner: dropped, and reported.
  const workaround = vercelEnvFor(unrecorded, TOKEN, { VERCEL_ORG_ID: PERSONAL_OWNER });
  assert.deepEqual(workaround.ignored, ["VERCEL_ORG_ID"]);
  assert.ok(removed(workaround.env, "VERCEL_ORG_ID") && removed(workaround.env, "VERCEL_PROJECT_ID"));

  // End to end: a shell set up to deploy the KIT, running a satellite's
  // config, is refused before anything runs, env:sync included.
  for (const [command, run] of Object.entries(COMMANDS)) {
    const { runner, calls } = recordingRunner();
    await withEnv({ VERCEL_PROJECT_ID: "prj_test" }, () =>
      assert.rejects(
        run(fixture("satellite", { database: "own" }).cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
        disagrees("VERCEL_PROJECT_ID"),
        command,
      ),
    );
    assert.deepEqual(calls, [], `${command}: nothing ran`);
  }
});

test("F-48: doctor reports the shell refusal deploy, up and migrate stop on, and counts it", async () => {
  /**
   * `doctor` run in `shell`, with what it printed. Only strings are taken,
   * which is how this CLI writes: `doctor` spawns pnpm, so the test runner
   * gets to flush earlier tests' results (binary frames on stdout) meanwhile,
   * and swallowing those would drop them from the report.
   */
  const report = async (cliRoot: string, shell: Record<string, string>) => {
    const chunks: string[] = [];
    const { write: stdout } = process.stdout;
    const { write: stderr } = process.stderr;
    const sink = (original: typeof process.stdout.write, stream: NodeJS.WriteStream) =>
      ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk !== "string")
          return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
        chunks.push(chunk);
        return true;
      }) as typeof process.stdout.write;
    process.stdout.write = sink(stdout, process.stdout);
    process.stderr.write = sink(stderr, process.stderr);
    setQuiet(false);
    try {
      const problems = await withEnv(shell, () => doctor(cliRoot));
      return { problems, out: chunks.join("") };
    } finally {
      setQuiet(true);
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  };

  // The fixture has no Vercel CLI installed and the API is offline, so the
  // count is never zero: what matters is what the shell adds to it.
  const team = fixture("kit").cliRoot;
  const clean = await report(team, {});
  assert.match(clean.out, /shell project ids\s+ok none name another project/, clean.out);

  const refused = await report(team, { VERCEL_PROJECT_ID: "prj_kit" });
  assert.equal(refused.problems, clean.problems + 1, refused.out);
  assert.match(
    refused.out,
    /shell project ids\s+wrong — The shell names a different Vercel project than this config\. Nothing was run\./,
  );
  assert.match(refused.out, /VERCEL_PROJECT_ID=prj_kit, where this config has prj_test/);

  // An unchecked VERCEL_ORG_ID is a warning, as it is for deploy: not counted.
  const unrecorded = fixture("kit", { owner: "unrecorded" }).cliRoot;
  const baseline = await report(unrecorded, {});
  const ignored = await report(unrecorded, { VERCEL_ORG_ID: PERSONAL_OWNER });
  assert.equal(ignored.problems, baseline.problems, ignored.out);
  assert.match(ignored.out, /shell project ids\s+ignored VERCEL_ORG_ID — not passed to vercel/);
});

test("F-48: a checkout linked to another project is refused before anything runs, and never re-linked over", async () => {
  for (const owner of ["team", "personal", "unrecorded"] as const) {
    for (const [command, run] of Object.entries(COMMANDS)) {
      // The case the review names: a satellite checkout linked to the kit's
      // project. With no owner recorded, `vercel` would have deployed there.
      const { cliRoot, appRoot } = fixture("satellite", { database: "own", owner });
      mkdirSync(join(appRoot, ".vercel"), { recursive: true });
      writeFileSync(linkFile(appRoot), JSON.stringify({ projectId: "prj_test", orgId: "team_test" }));
      const { runner, calls } = recordingRunner();
      await assert.rejects(
        run(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
        mislinked("prj_test", "prj_sat"),
        `${owner}, ${command}`,
      );
      assert.deepEqual(calls, [], `${owner}, ${command}: nothing ran`);
      assert.equal(JSON.parse(readFileSync(linkFile(appRoot), "utf8")).projectId, "prj_test", "left alone");
    }
  }

  const root = join(workspace, `link-${++fixtures}`);
  mkdirSync(join(root, ".vercel"), { recursive: true });
  const named = { projectId: "my-app" };
  writeFileSync(linkFile(root), JSON.stringify({ projectId: "prj_1", projectName: "my-app" }));
  assert.doesNotThrow(
    () => assertCheckoutLink(root, named, { required: true }),
    "a config naming its project by name, as `vercel` itself matches it",
  );
  writeFileSync(linkFile(root), "{not json");
  assert.throws(
    () => assertCheckoutLink(root, named, { required: false }),
    refusal(/project\.json is not valid JSON/, /Delete it and re-run/, 2),
  );
  writeFileSync(linkFile(root), "null");
  assert.throws(
    () => assertCheckoutLink(root, named, { required: false }),
    refusal(/names no project id, and this config deploys my-app/),
  );
  rmSync(linkFile(root));
  assert.doesNotThrow(() => assertCheckoutLink(root, named, { required: false }));
  assert.throws(
    () => assertCheckoutLink(root, named, { required: true }),
    refusal(/^vercel link wrote no .*project\.json/, /drk-deploy init/, 2),
  );
});

test("F-48: with no owner recorded, what `vercel link` wrote is checked before anything is pulled", async () => {
  const cases: [string, string | null, (err: unknown) => boolean][] = [
    ["wrote nothing", null, refusal(/^vercel link wrote no .*project\.json/, /drk-deploy init/, 2)],
    ["linked another project", "prj_other", mislinked("prj_other", "prj_test")],
  ];
  for (const [name, linked, refused] of cases) {
    const { runner, calls } = recordingRunner({ linked });
    await assert.rejects(
      deploy(fixture("kit", { owner: "unrecorded" }).cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
      refused,
      name,
    );
    assert.deepEqual(calls, ["envCheck", "link"], `${name}: nothing pulled, migrated, built or promoted`);
  }

  // With an owner recorded the pair names the project, and `vercel link`
  // writes nothing, so no link file is needed after it.
  const { cliRoot, kitRoot } = fixture("kit", { owner: "personal" });
  const paired = recordingRunner();
  await deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, paired.runner);
  assert.deepEqual(paired.calls, KIT_ORDER);

  // Nor can `vercel link` then point the checkout at another project. A file
  // naming one can only have been there already, and is refused before
  // anything runs, as it is for every owner and command above.
  writeFileSync(linkFile(kitRoot), JSON.stringify({ projectId: "prj_other" }));
  const wrong = recordingRunner();
  await assert.rejects(
    deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, wrong.runner),
    mislinked("prj_other", "prj_test"),
  );
  assert.deepEqual(wrong.calls, []);
});

test("F-48: init records the project's owner from the project itself, for a personal account too", async () => {
  // What `GET /v9/projects/{id}` answers for a personal account's project,
  // trimmed to the fields the SDK insists on.
  const project = (accountId: string) => ({
    id: "prj_personal",
    name: "mine",
    accountId,
    alias: [],
    nodeVersion: "24.x",
    defaultResourceConfig: { functionDefaultRegions: [] },
    resourceConfig: { functionDefaultRegions: [] },
    deploymentExpiration: {},
  });
  const requests: string[] = [];
  let answer = project(PERSONAL_OWNER);
  globalThis.fetch = (async (input: RequestInfo | URL, request?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(
      `${request?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}${url.search}`,
    );
    if (url.hostname === "api.vercel.com" && url.pathname === "/v9/projects/prj_personal") {
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`init made an unexpected call: ${url}`);
  }) as typeof fetch;

  try {
    // A first `init` from a personal account: no --team.
    const { cliRoot, kitRoot } = fixture("kit", { migratableKit: true, owner: "unrecorded" });
    rmSync(join(cliRoot, ".drk-deploy.json"));
    const options = { project: "prj_personal", domain: "mine.example.com", kitRoot, yes: true };
    await init(cliRoot, options);
    const config = configOf(cliRoot);
    assert.equal(config.orgId, PERSONAL_OWNER);
    assert.equal("teamId" in config, false);
    assert.deepEqual(requests, ["GET /v9/projects/prj_personal"], "read in the personal scope: no teamId");
    assert.equal(vercelEnvFor(config, TOKEN, {}).env.VERCEL_ORG_ID, PERSONAL_OWNER);

    // Re-running it re-reads the owner rather than inheriting the recorded one.
    answer = project("team_moved");
    await init(cliRoot, options);
    assert.equal(configOf(cliRoot).orgId, "team_moved");

    // And an answer without one records none, rather than keeping a stale one.
    answer = project("");
    await init(cliRoot, options);
    assert.equal("orgId" in configOf(cliRoot), false);
  } finally {
    globalThis.fetch = offline;
  }
});

test("F-48: every vercel child is spawned in one place, with the environment the builder made", () => {
  // Read from source: the question is where the code BUILDS an environment
  // and spawns `vercel`, which comments may mention freely.
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(src, { recursive: true })
    .map((file) => String(file).replace(/\\/g, "/"))
    .filter((file) => file.endsWith(".ts"));
  const code = (file: string) =>
    readFileSync(join(src, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  const spawning = files.filter((file) => /\[\s*vercelJs\b/.test(code(file)));
  assert.deepEqual(spawning, ["commands/release.ts"]);
  const release = code("commands/release.ts");
  assert.equal(release.match(/\[\s*vercelJs\b/g)?.length, 1, "one spawn site");
  assert.match(
    release,
    /async function runVercel\(\s*\{ vercelJs, root, env \}: VercelInvocation,[\s\S]*?runOrThrow\(process\.execPath, \[vercelJs, \.\.\.args\], \{ cwd: root, env, failureMessage \}\)/,
    "it is runVercel's, which spawns with the invocation's env",
  );
  assert.match(
    release,
    /const \{ env, orgId, ignored \} = vercelEnvFor\(config, token\);/,
    "and the invocation's env is the builder's",
  );

  const writing = files.filter((file) => /\b(?:VERCEL|NOW)_(?:ORG|PROJECT)_ID\s*:/.test(code(file)));
  assert.deepEqual(writing, ["lib/vercel-project.ts"], "the pair is set in one place");
});

/* ================================================================== */
/*  F-45: the guards inside the REAL migrate()                         */
/* ================================================================== */

// The tests above fake `migrate`, and the table tests pass `satellite` by
// hand, so neither shows that `migrate` refuses anything. Both commands that
// reach it check the target first, but `migrate` is the function that touches
// the database, so the two guards inside it run again. Both refuse before
// anything is resolved, installed or spawned. The fixture's kit checkout is
// empty, so without a guard these runs fail on a missing directory instead of
// reaching a database. That is also a rejection, which is why each assertion
// names the refusal it expects.

/** Runs `fn` with these variables in the shell, then puts the shell back. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("migrate: refuses a satellite on the kit's database, even when it names a database URL", async () => {
  const policy = (err: unknown) =>
    err instanceof CliError &&
    err.exitCode === 2 &&
    /^Refusing to migrate: this satellite runs against the KIT's database/.test(err.message) &&
    /--own-database/.test(err.hint ?? "");
  await assert.rejects(migrate(fixture("satellite").cliRoot, { databaseUrl: FLAG }), policy);

  // The command refuses before it links or pulls anything.
  const { runner, calls } = recordingRunner();
  await assert.rejects(migrateCommand(fixture("satellite").cliRoot, { databaseUrl: FLAG }, runner), policy);
  assert.deepEqual(calls, []);
});

test("migrate: a satellite that owns its database never inherits the kit's URL from the shell", async () => {
  // The shell is set up to deploy the kit, the case the guard exists for:
  // every one of the kit's variables is set, and the satellite's is not.
  const { cliRoot } = fixture("satellite", { database: "own" });
  const inherited = (err: unknown) =>
    err instanceof CliError &&
    /^No database URL/.test(err.message) &&
    /deliberately NOT used/.test(err.hint ?? "");
  await withEnv(KIT_SHELL, () => assert.rejects(migrate(cliRoot, {}), inherited));

  const { runner, calls } = recordingRunner();
  await withEnv(KIT_SHELL, () => assert.rejects(migrateCommand(cliRoot, {}, runner), inherited));
  assert.deepEqual(calls, []);
});

test("migrate: the shell's libpq fallbacks (PGPORT, PGDATABASE, ...) never reach the migration runner", async () => {
  // `pg` fills any part the URL leaves out from PGHOST, PGPORT, PGDATABASE and
  // PGUSER. The target check reads the URL alone (no port is 5432, no
  // database is the user's name), so a shell's PGPORT=5433 would have the
  // runner migrate a server the check never saw. The migration runs for
  // real here (the kit's scripts are a probe that records what it was
  // handed), because only the spawned child shows what actually reached it.
  const { kitRoot } = fixture("kit", { migratableKit: true });
  const out = join(kitRoot, "probe-out.jsonl");
  const keys = ["DATABASE_URL", "DB_SCHEMA", "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER"];
  writeFileSync(
    join(kitRoot, "probe.cjs"),
    `const keys = ${JSON.stringify(keys)};\n` +
      `require("node:fs").appendFileSync(process.env.DRK_PROBE_OUT, JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))) + "\\n");\n`,
  );
  writeFileSync(
    join(kitRoot, "package.json"),
    JSON.stringify({ scripts: { "db:app:migrate": "node probe.cjs", "db:auth:migrate": "node probe.cjs" } }),
  );

  const shell = {
    DRK_PROBE_OUT: out,
    PGHOST: "localhost",
    PGHOSTADDR: "127.0.0.1",
    PGPORT: "5433",
    PGDATABASE: "other",
    PGUSER: "someone",
  };
  await withEnv(shell, () =>
    applyMigrations({ kitRoot, databaseUrl: PRODUCTION_DIRECT, schema: "tenant_a", dryRun: false }),
  );
  const runs = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const expected = {
    DATABASE_URL: PRODUCTION_DIRECT,
    DB_SCHEMA: "tenant_a",
    PGHOST: null,
    PGHOSTADDR: null,
    PGPORT: null,
    PGDATABASE: null,
    PGUSER: null,
  };
  assert.deepEqual(
    runs,
    [expected, expected],
    "both runners see the URL and the schema, and nothing else that picks a server",
  );

  // On Windows a variable's name is case-insensitive, so `pgport` is PGPORT
  // to the child: it is dropped however the shell spelled it.
  const env = migrationEnv(PRODUCTION_DIRECT, "auth", { pgport: "5433", PgDatabase: "other", PATH: "/bin" });
  assert.equal(env.DATABASE_URL, PRODUCTION_DIRECT);
  assert.equal(env.DB_SCHEMA, "auth");
  for (const key of ["pgport", "PgDatabase", "PGHOST", "PGPORT"]) {
    assert.ok(key in env && env[key] === undefined, `${key} is removed from the child's environment`);
  }
  assert.equal("PATH" in env, false, "everything else is inherited as it was");
});

test("migrate: the guards let the kit use its named URL and a satellite use its own (dry run)", async () => {
  // The other direction. A guard that refused everything would pass both
  // tests above.
  await withEnv(KIT_SHELL, () => migrate(fixture("kit", { migratableKit: true }).cliRoot, { dryRun: true }));
  const owned = { database: "own", migratableKit: true } as const;
  await withEnv({ ...KIT_SHELL, SATELLITE_DIRECT_DATABASE_URL: SATELLITE_URL }, () =>
    migrate(fixture("satellite", owned).cliRoot, { dryRun: true }),
  );
  await migrate(fixture("satellite", owned).cliRoot, { databaseUrl: FLAG, dryRun: true });
});
