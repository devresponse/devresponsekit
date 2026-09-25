import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Tests run against the BUILT output, so they exercise exactly what ships.
import { deploy, migrate, releaseRunner, resolveMigrationUrl, up } from "../dist/commands/release.js";
import { CliError, setQuiet } from "../dist/lib/log.js";

/* ================================================================== */
/*  F-45: the release ORDER, asserted rather than read                 */
/* ================================================================== */

/**
 * Every step `deploy` and `up` reach through the runner, in the order `up`
 * runs them. A fake is built from this list, so a step added to the real
 * runner without a fake fails the first test below instead of reaching
 * Vercel or a database from a test.
 */
const STEPS = ["envSync", "envCheck", "migrate", "link", "pull", "build", "promote", "verify"];

/** `deploy` with a preflight, on a target that owns its schema. */
const KIT_ORDER = ["envCheck", "migrate", "link", "pull", "build", "promote", "verify"];
/** `up`: env:sync replaces the preflight (it would only repeat itself). */
const UP_ORDER = ["envSync", "migrate", "link", "pull", "build", "promote", "verify"];

const TOKEN = "test-token-that-never-leaves-this-process";

/** Every variable the release path reads from the shell, scrubbed for the run. */
const AMBIENT = [
  "VERCEL_TOKEN",
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "PRODUCTION_DIRECT_DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "DATABASE_URL",
  "SATELLITE_DIRECT_DATABASE_URL",
];

let workspace = "";
const savedEnv: Record<string, string | undefined> = {};
const savedFetch = globalThis.fetch;

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
  globalThis.fetch = (async () => {
    throw new Error("a release test reached the network");
  }) as typeof fetch;
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
 */
function fixture(
  target: "kit" | "satellite",
  options: { database?: "own"; migratableKit?: boolean } = {},
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

  const base = {
    projectId: "prj_test",
    teamId: "team_test",
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

/** A runner that records each step it is asked to run, and can fail one. */
function recordingRunner(options: { failAt?: string; envProblems?: number } = {}) {
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  const runner = Object.fromEntries(
    STEPS.map((name) => [
      name,
      async (...received: unknown[]) => {
        calls.push(name);
        args[name] = received;
        if (options.failAt === name) throw new Error(`${name} failed`);
        return name === "envCheck" ? (options.envProblems ?? 0) : undefined;
      },
    ]),
  );
  return { runner: runner as never, calls, args };
}

test("the recording fake stands in for EVERY real step, so no test can reach Vercel", () => {
  assert.deepEqual(
    Object.keys(releaseRunner).sort(),
    [...STEPS].sort(),
    "a step added to releaseRunner must be added to STEPS, or these tests would run the real one",
  );
});

test("deploy: preflight → migrate → link → pull → build → promote → verify, exactly once each", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const { runner, calls, args } = recordingRunner();
  await deploy(cliRoot, { databaseUrl: "postgresql://u@db.example.com/app", schema: "auth" }, runner);
  assert.deepEqual(calls, KIT_ORDER);

  // What the steps were handed: the migration options as given, and the
  // token in the child's ENVIRONMENT (never argv) for every Vercel call.
  assert.deepEqual(args.migrate, [
    cliRoot,
    { databaseUrl: "postgresql://u@db.example.com/app", schema: "auth" },
  ]);
  for (const name of ["link", "pull", "build", "promote"]) {
    const [invocation] = args[name] as [{ root: string; env: Record<string, string>; vercelJs: string }];
    assert.equal(invocation.root, kitRoot, `${name} runs in the kit checkout`);
    assert.equal(invocation.env.VERCEL_TOKEN, TOKEN, `${name} carries the token in its environment`);
    assert.equal(invocation.env.VERCEL_PROJECT_ID, "prj_test");
    assert.equal(invocation.env.VERCEL_ORG_ID, "team_test");
    assert.equal(invocation.vercelJs, join(cliRoot, "node_modules", "vercel", "dist", "vc.js"));
  }
});

test("deploy: NOTHING runs after a failed step — a failed migration promotes nothing", async () => {
  for (const [index, failing] of KIT_ORDER.entries()) {
    const { cliRoot } = fixture("kit");
    const { runner, calls } = recordingRunner({ failAt: failing });
    await assert.rejects(deploy(cliRoot, {}, runner), new RegExp(`^Error: ${failing} failed$`));
    assert.deepEqual(calls, KIT_ORDER.slice(0, index + 1), `after ${failing} failed`);
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
  await deploy(fixture("kit").cliRoot, { yes: true }, forced.runner);
  assert.deepEqual(forced.calls, KIT_ORDER, "--yes deploys anyway, in the same order");
});

test("deploy: the flags that drop a step drop only that step", async () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    ["--skip-checks", { skipChecks: true }, KIT_ORDER.filter((s) => s !== "envCheck")],
    ["--skip-migrations", { skipMigrations: true }, KIT_ORDER.filter((s) => s !== "migrate")],
    // A dry run still walks the migration step (in dry-run mode) and stops
    // before anything reaches Vercel.
    ["--dry-run", { dryRun: true }, ["envCheck", "migrate"]],
  ];
  for (const [flag, options, expected] of cases) {
    const { runner, calls, args } = recordingRunner();
    await deploy(fixture("kit").cliRoot, options, runner);
    assert.deepEqual(calls, expected, flag);
    if (flag === "--dry-run") assert.deepEqual((args.migrate as unknown[])[1], { dryRun: true });
  }
});

test("deploy: a satellite on the kit's database has no migrate step, and deploys its own checkout", async () => {
  const { cliRoot, appRoot } = fixture("satellite");
  const { runner, calls, args } = recordingRunner();
  await deploy(cliRoot, {}, runner);
  assert.deepEqual(
    calls,
    KIT_ORDER.filter((s) => s !== "migrate"),
  );
  assert.equal((args.pull as [{ root: string }])[0].root, appRoot);
  assert.equal((args.verify as [unknown, { kind: string }])[1].kind, "satellite");
});

test("up: env:sync → migrate → link → pull → build → promote → verify, and nothing after a failure", async () => {
  const whole = recordingRunner();
  await up(fixture("kit").cliRoot, {}, whole.runner);
  assert.deepEqual(whole.calls, UP_ORDER, "env:check is not repeated after env:sync");
  assert.equal((whole.args.envSync as [string, { target: string }])[1].target, "production");

  for (const [index, failing] of UP_ORDER.entries()) {
    const { runner, calls } = recordingRunner({ failAt: failing });
    await assert.rejects(up(fixture("kit").cliRoot, {}, runner), new RegExp(`^Error: ${failing} failed$`));
    assert.deepEqual(calls, UP_ORDER.slice(0, index + 1), `after ${failing} failed`);
  }
});

/* ================================================================== */
/*  F-45: which database a migration runs against                      */
/* ================================================================== */

const FLAG = "postgresql://flag@flag.example.com/app";
const KIT_SHELL = {
  PRODUCTION_DIRECT_DATABASE_URL: "postgresql://kit@kit-direct.example.com/app",
  DIRECT_DATABASE_URL: "postgresql://direct@direct.example.com/app",
  DATABASE_URL: "postgresql://runtime@runtime.example.com/app",
};
const SATELLITE_URL = "postgresql://sat@satellite.example.com/app";
const POOLED = "postgresql://u@ep-quiet-cell-123456-pooler.us-east-2.aws.neon.tech/app";

test("resolveMigrationUrl: the kit's precedence, and a satellite never inherits the kit's database", () => {
  const cases: [string, Record<string, unknown>, Record<string, string>, string][] = [
    ["kit: --database-url wins", { databaseUrl: FLAG }, KIT_SHELL, FLAG],
    ["kit: PRODUCTION_DIRECT first", {}, KIT_SHELL, KIT_SHELL.PRODUCTION_DIRECT_DATABASE_URL],
    [
      "kit: then DIRECT",
      {},
      { DIRECT_DATABASE_URL: KIT_SHELL.DIRECT_DATABASE_URL, DATABASE_URL: KIT_SHELL.DATABASE_URL },
      KIT_SHELL.DIRECT_DATABASE_URL,
    ],
    ["kit: then DATABASE_URL", {}, { DATABASE_URL: KIT_SHELL.DATABASE_URL }, KIT_SHELL.DATABASE_URL],
    [
      "kit: SATELLITE_DIRECT is not a kit variable",
      {},
      { ...KIT_SHELL, SATELLITE_DIRECT_DATABASE_URL: SATELLITE_URL },
      KIT_SHELL.PRODUCTION_DIRECT_DATABASE_URL,
    ],
    [
      "satellite: SATELLITE_DIRECT, over every kit variable",
      { requireExplicit: true },
      { ...KIT_SHELL, SATELLITE_DIRECT_DATABASE_URL: SATELLITE_URL },
      SATELLITE_URL,
    ],
    [
      "satellite: --database-url wins",
      { requireExplicit: true, databaseUrl: FLAG },
      { SATELLITE_DIRECT_DATABASE_URL: SATELLITE_URL },
      FLAG,
    ],
    ["pooled, explicitly allowed", { databaseUrl: POOLED, allowPooled: true }, {}, POOLED],
  ];
  for (const [name, options, env, expected] of cases) {
    assert.equal(resolveMigrationUrl(options, env), expected, name);
  }
});

test("resolveMigrationUrl: refuses a missing, inherited or pooled URL, and says why", () => {
  const refusal = (message: RegExp, hint: RegExp) => (err: unknown) =>
    err instanceof CliError && message.test(err.message) && hint.test(err.hint ?? "");

  const cases: [string, Record<string, unknown>, Record<string, string>, (err: unknown) => boolean][] = [
    ["kit, nothing set", {}, {}, refusal(/^No database URL/, /PRODUCTION_DIRECT_DATABASE_URL/)],
    // The guard the satellite split exists for: a shell set up to deploy the
    // kit must not hand a satellite the KIT's production database.
    [
      "satellite, only the kit's variables set",
      { requireExplicit: true },
      KIT_SHELL,
      refusal(/^No database URL/, /deliberately NOT used/),
    ],
    ["kit, pooled flag", { databaseUrl: POOLED }, {}, refusal(/POOLED/, /--allow-pooled/)],
    [
      "kit, pooled fallback",
      {},
      { PRODUCTION_DIRECT_DATABASE_URL: POOLED },
      refusal(/POOLED/, /--allow-pooled/),
    ],
    [
      "satellite, pooled",
      { requireExplicit: true },
      { SATELLITE_DIRECT_DATABASE_URL: POOLED },
      refusal(/POOLED/, /--allow-pooled/),
    ],
  ];
  for (const [name, options, env, matches] of cases) {
    assert.throws(() => resolveMigrationUrl(options, env), matches, name);
  }
});

/* ================================================================== */
/*  F-45: the guards inside the REAL migrate()                         */
/* ================================================================== */

// The tests above fake `migrate`, and the table tests pass `requireExplicit`
// by hand, so neither shows that `migrate` refuses anything. `drk-deploy
// migrate` calls it directly, never through deploy()'s policy branch, so on
// that command the two guards inside it are the only protection. Both refuse
// before anything is resolved, installed or spawned. The fixture's kit
// checkout is empty, so without a guard these runs fail on a missing
// directory instead of reaching a database. That is also a rejection, which
// is why each assertion names the refusal it expects.

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
  await assert.rejects(
    migrate(fixture("satellite").cliRoot, { databaseUrl: FLAG }),
    (err: unknown) =>
      err instanceof CliError &&
      err.exitCode === 2 &&
      /^Refusing to migrate: this satellite runs against the KIT's database/.test(err.message) &&
      /--own-database/.test(err.hint ?? ""),
  );
});

test("migrate: a satellite that owns its database never inherits the kit's URL from the shell", async () => {
  // The shell is set up to deploy the kit, the case the guard exists for:
  // every one of the kit's fallbacks is set, and the satellite's is not.
  const { cliRoot } = fixture("satellite", { database: "own" });
  await withEnv(KIT_SHELL, () =>
    assert.rejects(
      migrate(cliRoot, {}),
      (err: unknown) =>
        err instanceof CliError &&
        /^No database URL/.test(err.message) &&
        /deliberately NOT used/.test(err.hint ?? ""),
    ),
  );
});

test("migrate: the guards let the kit use the shell's URL and a satellite use its own (dry run)", async () => {
  // The other direction. A guard that refused everything would pass both
  // tests above.
  await withEnv(KIT_SHELL, () => migrate(fixture("kit", { migratableKit: true }).cliRoot, { dryRun: true }));
  const owned = { database: "own", migratableKit: true } as const;
  await withEnv({ ...KIT_SHELL, SATELLITE_DIRECT_DATABASE_URL: SATELLITE_URL }, () =>
    migrate(fixture("satellite", owned).cliRoot, { dryRun: true }),
  );
  await migrate(fixture("satellite", owned).cliRoot, { databaseUrl: FLAG, dryRun: true });
});
