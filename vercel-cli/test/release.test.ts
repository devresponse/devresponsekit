import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Command } from "commander";

// Tests run against the BUILT output, so they exercise exactly what ships.
import { doctor } from "../dist/commands/doctor.js";
import { init, recordedSatelliteAnswers } from "../dist/commands/init.js";
import {
  deploy,
  migrate,
  migrateCommand,
  releaseRunner,
  resolveMigrationUrl,
  up,
} from "../dist/commands/release.js";
import { configFileFrom, configPath, requireConfig, useConfigFile } from "../dist/lib/config.js";
import { applyMigrations, migrationEnv } from "../dist/lib/kit.js";
import { CliError, setQuiet } from "../dist/lib/log.js";
import { withRollbackOptions } from "../dist/lib/rollback-options.js";
import { verifyMigrationTarget } from "../dist/lib/migration-target.js";
import {
  describeCommit,
  gitEnv,
  inspectTree,
  productionAutoDeploy,
  readStatus,
  treeProblems,
} from "../dist/lib/release-tree.js";
import { projectGit } from "../dist/lib/vercel-client.js";
import { resolveProfile } from "../dist/lib/target.js";
import { assertCheckoutLink, issuerProjectProblem, vercelEnvFor } from "../dist/lib/vercel-project.js";

/* ================================================================== */
/*  F-45 / F-47: the release ORDER, asserted rather than read          */
/* ================================================================== */

/**
 * Every step the commands reach through the runner, in the order `up` runs
 * them. A fake is built from this list, so a step added to the real runner
 * without a fake fails the first test below instead of reaching Vercel or a
 * database from a test.
 */
const STEPS = [
  "tree",
  "project",
  "serving",
  "envSync",
  "envCheck",
  "link",
  "pull",
  "migrate",
  "build",
  "promote",
  "verify",
  "rollback",
];

/**
 * The F-49 and F-50 checks of a run that promotes: the checkout's commit, then
 * the project (is it the SSO issuer's own? does Vercel deploy production by
 * itself?). Both only read, and a refusal stops the run here.
 */
const CHECKS = ["tree", "project"];
/**
 * The whole gate of a run that goes ahead: the checks, then which deployment
 * production serves, which an unhealthy probe rolls back to (F-51). All read,
 * and all come before anything writes.
 */
const GATE = [...CHECKS, "serving"];

/**
 * `deploy` with a preflight, on a target that owns its schema. `pull` comes
 * before `migrate` (F-47): production's variables are what the migration
 * target is checked against.
 */
const KIT_ORDER = ["envCheck", ...GATE, "link", "pull", "migrate", "build", "promote", "verify"];
/** `up`: env:sync replaces the preflight (it would only repeat itself), after the F-49 checks. */
const UP_ORDER = [...GATE, "envSync", "link", "pull", "migrate", "build", "promote", "verify"];
/** `drk-deploy migrate`: the first half of `deploy`. It promotes nothing, so it reads the tree alone. */
const MIGRATE_ORDER = ["tree", "link", "pull", "migrate"];
/** A satellite's `migrate` reads the project too, before anything is linked: never the issuer's (F-50). */
const SATELLITE_MIGRATE_ORDER = ["tree", "project", "link", "pull", "migrate"];
/** Where `deploy` stops when the migration target is refused: after the pull, before anything migrates. */
const DEPLOY_TO_PULL = ["envCheck", ...GATE, "link", "pull"];

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
 *
 * Its `tree` answers what `inspectTree` would for each checkout (F-49): by
 * default a clean one on main, pushed, at origin/main, and `trees` describes
 * any other, by root. Each call is recorded in `inspected`, with the
 * `--allow-ref` it was handed. Its `project` answers the configured project
 * with `git` as its git connection, by default none connected, so nothing
 * else deploys it, and `aliases` as its production aliases, by default none,
 * so it is nobody's issuer (F-50).
 *
 * Its `serving` answers `serving`, by default {@link PREVIOUS}, the
 * deployment production serves before the run (F-51); `null` is a production
 * that serves none yet. Its `verify` answers each verdict in `verdicts` in
 * turn, and healthy once they run out, so `[UNHEALTHY]` is a promoted build
 * that fails its probe and a rollback that restores a healthy one. Its
 * `rollback` records the deployment it was handed.
 */
function recordingRunner(
  options: {
    failAt?: string;
    envProblems?: number;
    production?: Record<string, string> | null;
    linked?: string | null;
    trees?: Record<string, FakeTree>;
    git?: ProjectGit;
    aliases?: string[];
    serving?: { id: string; url: string | null } | null;
    verdicts?: { healthy: boolean; problems: string[] }[];
  } = {},
) {
  const verdicts = [...(options.verdicts ?? [])];
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  /** Every call's arguments, by step, where `args` keeps only the last. */
  const every: Record<string, unknown[][]> = {};
  const inspected: { root: string; allowRef: string | undefined }[] = [];
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
        (every[name] ??= []).push(received);
        if (name === "tree") {
          const [root, allowRef] = received as [string, string | undefined];
          inspected.push({ root, allowRef });
          if (options.failAt === name) throw new Error(`${name} failed`);
          return fakeTree(root, allowRef, options.trees?.[root]);
        }
        if (name === "project") {
          if (options.failAt === name) throw new Error(`${name} failed`);
          const { config } = received[0] as { config: { projectId: string } };
          return {
            id: config.projectId,
            name: config.projectId.replace(/^prj_/, ""),
            accountId: null,
            framework: "nextjs",
            aliases: options.aliases ?? [],
            git: options.git ?? NO_GIT,
          };
        }
        if (name === "serving") {
          if (options.failAt === name) throw new Error(`${name} failed`);
          return options.serving === undefined ? PREVIOUS : options.serving;
        }
        if (name === "verify") {
          if (options.failAt === name) throw new Error(`${name} failed`);
          return verdicts.shift() ?? HEALTHY;
        }
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
  return { runner: runner as never, calls, args, every, seen, inspected };
}

/** The deployment the fake `serving` step says production serves before a run (F-51). */
const PREVIOUS = { id: "dpl_previous123", url: "kit-previous123.vercel.app" };
/** What the fake `verify` step answers unless a test says otherwise. */
const HEALTHY = { healthy: true, problems: [] };
/** A promoted build that fails its probe. */
const UNHEALTHY = { healthy: false, problems: ["its health probes fail (see above)"] };

/** The commits the fake `tree` step reports. */
const MAIN_SHA = "1111111111111111111111111111111111111111";
const PR_SHA = "2222222222222222222222222222222222222222";

/**
 * A checkout as the fake `tree` step reports it (F-49). Every field defaults
 * to what a release may be made from: HEAD at MAIN_SHA on main, a clean tree,
 * pushed as origin/main. `refs` is what each ref resolves to (origin/main is
 * MAIN_SHA), and the release ref is `--allow-ref` or else origin/main, which
 * is how `inspectTree` resolves it.
 */
interface FakeTree {
  notRepository?: string;
  head?: string | null;
  branch?: string | null;
  changes?: string[];
  generated?: string[];
  pushedAs?: string[];
  refs?: Record<string, string>;
}

function fakeTree(root: string, allowRef: string | undefined, tree: FakeTree = {}) {
  const refs = tree.refs ?? { "origin/main": MAIN_SHA };
  const ref = allowRef ?? "origin/main";
  return {
    root,
    notRepository: tree.notRepository ?? null,
    head: tree.head === undefined ? MAIN_SHA : tree.head,
    branch: tree.branch === undefined ? "main" : tree.branch,
    changes: tree.changes ?? [],
    generated: tree.generated ?? [],
    pushedAs: tree.pushedAs ?? ["origin/main"],
    release: { ref, commit: refs[ref] ?? null },
  };
}

/** `ProjectGit` (lib/vercel-client.ts): what decides whether Vercel deploys production by itself. */
type ProjectGit = {
  repository: string | null;
  productionBranch: string | null;
  ignoreCommand: string | null;
};

/** What the Vercel API answers for a project with no repository connected. */
const NO_GIT: ProjectGit = { repository: null, productionBranch: null, ignoreCommand: null };
/** The kit's own production today: a GitHub repository whose pushes to main Vercel promotes. */
const GIT_CONNECTED: ProjectGit = {
  repository: "github:devresponse/devresponsekit",
  productionBranch: "main",
  ignoreCommand: null,
};

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
    // A dry run reads the checkout and the project's git connection (F-49,
    // both read-only), walks the migration step in dry-run mode, and stops
    // before anything is linked, pulled or built, so nothing is checked
    // against production.
    ["--dry-run", { ...url, dryRun: true }, ["envCheck", ...GATE, "migrate"]],
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
  assert.deepEqual(dry.calls, ["tree", "migrate"], "the tree is read and reported, not refused");
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
    assert.deepEqual(calls, DEPLOY_TO_PULL, `${name}: nothing migrated, built or promoted`);
    assert.equal(existsSync(pulledFile(kitRoot)), false, `${name}: the pulled file is removed`);
  }

  // up and the migrate command stop at the same place.
  const upped = recordingRunner();
  await assert.rejects(up(fixture("kit").cliRoot, { databaseUrl: LOCAL }, upped.runner), refused);
  assert.deepEqual(upped.calls, [...GATE, "envSync", "link", "pull"]);
  const migrated = recordingRunner();
  await assert.rejects(
    migrateCommand(fixture("kit").cliRoot, { databaseUrl: LOCAL }, migrated.runner),
    refused,
  );
  assert.deepEqual(migrated.calls, ["tree", "link", "pull"]);

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
  assert.deepEqual(overridden.calls, DEPLOY_TO_PULL);
});

test("F-47: a satellite that owns its database is checked against ITS production the same way", async () => {
  const owned = { database: "own" } as const;
  const { cliRoot, appRoot } = fixture("satellite", owned);
  const { runner, calls, args } = recordingRunner();
  await assert.rejects(deploy(cliRoot, { databaseUrl: LOCAL }, runner), refusal(/not production's database/));
  // Two checkouts are read (F-49): the satellite's, which is built, and the
  // kit's, which the migrations come from.
  assert.deepEqual(calls, ["envCheck", "tree", "tree", "project", "serving", "link", "pull"]);
  assert.equal((args.pull as [{ root: string }])[0].root, appRoot, "its own checkout's pull");

  const matched = recordingRunner();
  await deploy(fixture("satellite", owned).cliRoot, { databaseUrl: PRODUCTION_DIRECT }, matched.runner);
  assert.deepEqual(matched.calls, ["envCheck", "tree", ...KIT_ORDER.filter((s) => s !== "envCheck")]);
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
  assert.deepEqual(mismatched.calls, DEPLOY_TO_PULL);
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
  assert.deepEqual(refused.calls, DEPLOY_TO_PULL);

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
    assert.deepEqual(calls, DEPLOY_TO_PULL);
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
  assert.deepEqual(nothing.calls, DEPLOY_TO_PULL);
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
    assert.deepEqual(
      calls,
      ["envCheck", ...GATE, "link"],
      `${name}: nothing pulled, migrated, built or promoted`,
    );
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

/* ================================================================== */
/*  F-49: a release is a clean, pushed commit, and names it            */
/* ================================================================== */

/**
 * Runs `fn` with this CLI's output captured and quiet mode off, and hands it
 * the output so far. Only strings are taken, as in the doctor test above: the
 * test runner flushes its own binary frames on stdout meanwhile.
 */
async function captureOutput<T>(
  fn: (soFar: () => string) => Promise<T>,
): Promise<{ result: T | undefined; error: unknown; out: string }> {
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
    const result = await fn(() => chunks.join(""));
    return { result, error: undefined, out: chunks.join("") };
  } catch (error) {
    return { result: undefined, error, out: chunks.join("") };
  } finally {
    setQuiet(true);
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/**
 * `git` for building FIXTURE repositories, never the one under test, and
 * never the repository these tests run in. The user's global and system
 * configuration is left out (hooks, signing, templates, a default branch),
 * and so is every GIT_* variable of the shell: inside a git hook GIT_DIR is
 * set, and a fixture command would otherwise write to that repository.
 */
function gitFixture(cwd: string, ...args: string[]): string {
  const shell = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const emptyConfig = join(workspace, "empty.gitconfig");
  if (!existsSync(emptyConfig)) writeFileSync(emptyConfig, "");
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...shell,
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "drk-deploy test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "drk-deploy test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

/**
 * A checkout as a release is made from one: `work` (a new directory, or the
 * one given) with a first migration committed on main and pushed to a bare
 * `remote`, and origin/HEAD recorded the way a clone records it.
 */
function pushedCheckout(work = join(workspace, `git-${++fixtures}`, "work")): {
  work: string;
  remote: string;
  main: string;
} {
  const remote = `${work}-remote.git`;
  mkdirSync(join(work, "src", "db", "migrations"), { recursive: true });
  gitFixture(work, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  gitFixture(work, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(work, "src", "db", "migrations", "0001-initial-schema.sql"), "select 1;\n");
  gitFixture(work, "add", "-A");
  gitFixture(work, "commit", "--quiet", "-m", "initial");
  gitFixture(work, "remote", "add", "origin", remote);
  gitFixture(work, "push", "--quiet", "-u", "origin", "main");
  gitFixture(work, "remote", "set-head", "origin", "main");
  return { work, remote, main: gitFixture(work, "rev-parse", "HEAD") };
}

/** Commits one file, and returns the new HEAD. */
function commitFile(work: string, file: string, content: string): string {
  mkdirSync(join(work, file, ".."), { recursive: true });
  writeFileSync(join(work, file), content);
  gitFixture(work, "add", "-A");
  gitFixture(work, "commit", "--quiet", "-m", `add ${file}`);
  return gitFixture(work, "rev-parse", "HEAD");
}

const MIGRATION_0007 = "src/db/migrations/0007-foo.sql";

test("F-49: inspectTree reads a real checkout, untracked files included, and fetches nothing", async () => {
  const { work, remote, main } = pushedCheckout();
  assert.deepEqual(await inspectTree(work), {
    root: work,
    notRepository: null,
    head: main,
    branch: "main",
    changes: [],
    generated: [],
    pushedAs: ["origin/main"],
    release: { ref: "origin/main", commit: main },
  });

  // The recorded scenario's file: an untracked migration. A config that hides
  // untracked files from `git status` does not hide it here.
  gitFixture(work, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(work, MIGRATION_0007), "create table foo ();\n");
  writeFileSync(join(work, "src", "db", "migrations", "0001-initial-schema.sql"), "select 2;\n");
  const dirty = await inspectTree(work);
  assert.deepEqual(
    [...dirty.changes].sort(),
    [" M src/db/migrations/0001-initial-schema.sql", `?? ${MIGRATION_0007}`].sort(),
  );
  assert.equal(dirty.head, main, "reading changed nothing");

  // Committed but not pushed: no remote branch points at HEAD.
  const ahead = pushedCheckout();
  const aheadHead = commitFile(ahead.work, MIGRATION_0007, "create table foo ();\n");
  const unpushed = await inspectTree(ahead.work);
  assert.equal(unpushed.head, aheadHead);
  assert.deepEqual(unpushed.pushedAs, []);
  assert.equal(unpushed.release.commit, ahead.main, "origin/main is still the pushed commit");

  // A pull request's branch, pushed: its own remote branch points at HEAD.
  const pr = pushedCheckout();
  gitFixture(pr.work, "switch", "--quiet", "-c", "feature/0007");
  const prHead = commitFile(pr.work, MIGRATION_0007, "create table foo ();\n");
  gitFixture(pr.work, "push", "--quiet", "-u", "origin", "feature/0007");
  const onBranch = await inspectTree(pr.work);
  assert.equal(onBranch.branch, "feature/0007");
  assert.deepEqual(onBranch.pushedAs, ["origin/feature/0007"]);
  assert.deepEqual(onBranch.release, { ref: "origin/main", commit: pr.main });
  assert.deepEqual((await inspectTree(pr.work, "origin/feature/0007")).release, {
    ref: "origin/feature/0007",
    commit: prHead,
  });
  assert.deepEqual((await inspectTree(pr.work, "origin/nope")).release, { ref: "origin/nope", commit: null });

  // Detached at origin/main, as a CI checkout often is.
  gitFixture(pr.work, "checkout", "--quiet", "--detach", "origin/main");
  const detached = await inspectTree(pr.work);
  assert.equal(detached.branch, null);
  assert.equal(detached.head, pr.main);
  assert.deepEqual(detached.pushedAs, ["origin/main"]);

  // Another clone pushes to main. Nothing is fetched, so origin/main is still
  // what this checkout last fetched, and its refs are untouched.
  const other = join(workspace, `git-${++fixtures}`, "other");
  mkdirSync(join(other, ".."), { recursive: true });
  gitFixture(join(other, ".."), "clone", "--quiet", remote, other);
  const pushedElsewhere = commitFile(other, "elsewhere.txt", "x\n");
  gitFixture(other, "push", "--quiet", "origin", "main");
  const stale = await inspectTree(work);
  assert.equal(stale.release.commit, main, "origin/main as last fetched");
  assert.notEqual(stale.release.commit, pushedElsewhere);
  assert.equal(gitFixture(work, "rev-parse", "refs/remotes/origin/main"), main, "no ref was written");

  // A shell with GIT_DIR set (inside a git hook, say) does not redirect it,
  // however the name is spelled.
  const redirected = await withEnv({ GIT_DIR: join(other, ".git") }, () => inspectTree(work));
  assert.equal(redirected.head, main, "the checkout's own HEAD, not GIT_DIR's");
  const env = gitEnv({ git_dir: "x", GIT_WORK_TREE: "y", PATH: "/bin" });
  for (const key of ["git_dir", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
    assert.ok(key in env && env[key] === undefined, `${key} is removed from git's environment`);
  }
  assert.equal("PATH" in env, false);

  // Not a checkout at all.
  const plain = join(workspace, `plain-${++fixtures}`);
  mkdirSync(plain);
  const outside = await inspectTree(plain);
  assert.equal(typeof outside.notRepository, "string");
  assert.equal(outside.head, null);
  assert.match((await inspectTree(join(plain, "missing"))).notRepository ?? "", /does not exist/);
});

test("F-49: treeProblems: clean and pushed, and for a promotion the release ref, or it names what is wrong", () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    root: "/kit",
    notRepository: null,
    head: MAIN_SHA,
    branch: "main",
    changes: [] as string[],
    generated: [] as string[],
    pushedAs: ["origin/main"],
    release: { ref: "origin/main", commit: MAIN_SHA as string | null },
    ...overrides,
  });
  const onPr = { head: PR_SHA, branch: "feature/0007", pushedAs: ["origin/feature/0007"] };
  const kit = { label: "kit checkout", rule: "release" as const };
  const migrateOnly = { label: "kit checkout", rule: "any-pushed" as const };
  const forSatellite = { label: "kit checkout", rule: "default-branch" as const };

  assert.deepEqual(treeProblems(state(), kit), []);
  assert.deepEqual(treeProblems(state(), forSatellite), []);
  // A pushed pull request's branch: the kit's migrate may run from it, deploy
  // may not, and neither may a satellite's own database be migrated from it.
  assert.deepEqual(treeProblems(state(onPr), migrateOnly), []);
  // A next-env.d.ts that a build rewrote is set aside, so it stops nothing.
  assert.deepEqual(treeProblems(state({ generated: ["next-env.d.ts"] }), kit), []);

  const cases: [string, Record<string, unknown>, { label: string; rule: string }, RegExp, RegExp][] = [
    [
      "untracked migration",
      { changes: [`?? ${MIGRATION_0007}`] },
      migrateOnly,
      /^the kit checkout has 1 uncommitted change\(s\), untracked files included: \?\? src\/db\/migrations\/0007-foo\.sql$/,
      /git stash --include-untracked[\s\S]*ledgered under its checksum/,
    ],
    [
      "many changes, previewed",
      { changes: ["?? a", " M b", "A  c", "?? d", "?? e", "?? f", "?? g"] },
      migrateOnly,
      /7 uncommitted change\(s\), untracked files included: \?\? a, M b, A {2}c, \?\? d, \?\? e, and 2 more$/,
      /./,
    ],
    [
      "not pushed",
      { head: PR_SHA, branch: "feature/0007", pushedAs: [] },
      migrateOnly,
      /^the kit checkout's HEAD 222222222222 \(feature\/0007\) is not pushed: no remote-tracking branch points at it$/,
      /git push[\s\S]*nothing here fetches/,
    ],
    [
      "a promotion off origin/main",
      onPr,
      kit,
      /^the kit checkout's HEAD 222222222222 is not origin\/main \(111111111111\)$/,
      /--allow-ref <ref>[\s\S]*drk-deploy migrate/,
    ],
    [
      "no origin/main to compare with",
      { release: { ref: "origin/main", commit: null } },
      kit,
      /^the kit checkout has no origin\/main to compare HEAD with$/,
      /git fetch origin[\s\S]*--allow-ref/,
    ],
    [
      "a satellite's own database migrated from a pushed kit branch",
      onPr,
      forSatellite,
      /^the kit checkout's HEAD 222222222222 is not origin\/main \(111111111111\)$/,
      /^Check out what origin\/main holds in \/kit[\s\S]*ledgered under its checksum[\s\S]*No flag changes this\. --allow-ref names the satellite's ref, never the kit's\.$/,
    ],
    [
      "a satellite's own database, no origin/main in the kit checkout",
      { release: { ref: "origin/main", commit: null } },
      forSatellite,
      /^the kit checkout has no origin\/main to compare HEAD with$/,
      /^Fetch it in \/kit \(`git fetch origin`\)\. A satellite's own database/,
    ],
    [
      "not a git checkout",
      { notRepository: "fatal: not a git repository", head: null, branch: null, pushedAs: [] },
      kit,
      /^the kit checkout \(\/kit\) is not a git checkout$/,
      /git says: fatal: not a git repository/,
    ],
    [
      "no commit yet",
      { head: null, branch: "main", pushedAs: [] },
      kit,
      /^the kit checkout has no commit yet$/,
      /./,
    ],
  ];
  for (const [name, overrides, check, what, fix] of cases) {
    const problems = treeProblems(state(overrides), check);
    assert.ok(
      problems.some(
        (problem: { what: string; fix: string }) => what.test(problem.what) && fix.test(problem.fix),
      ),
      `${name}: ${JSON.stringify(problems)}`,
    );
  }
  // Every problem is reported, not just the first.
  assert.equal(treeProblems(state({ ...onPr, changes: ["?? x"], pushedAs: [] }), kit).length, 3);
});

/** The refusal for a checkout that is not releasable: exit 2, "Nothing was changed." */
const unreleasable = (action: string, what: RegExp, hint: RegExp = /./) =>
  refusal(new RegExp(`^Refusing to ${action}: ${what.source}\\. Nothing was changed\\.$`), hint, 2);

test("F-49: a dirty tree, untracked files included, is refused before anything writes, for deploy, up and migrate", async () => {
  const dirt: [string, string][] = [
    ["an untracked migration", `?? ${MIGRATION_0007}`],
    ["an edited tracked file", " M src/lib/env.ts"],
    ["a staged file", "A  src/db/migrations/0007-foo.sql"],
  ];
  const stopsAt: Record<string, string[]> = {
    deploy: ["envCheck", "tree"],
    up: ["tree"],
    migrate: ["tree"],
  };
  for (const [name, line] of dirt) {
    for (const [command, run] of Object.entries(COMMANDS)) {
      const { cliRoot, kitRoot } = fixture("kit");
      const { runner, calls } = recordingRunner({ trees: { [kitRoot]: { changes: [line] } } });
      await assert.rejects(
        run(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
        unreleasable(
          command === "migrate" ? "migrate" : "deploy",
          /the kit checkout has 1 uncommitted change\(s\), untracked files included: .+/,
          /Commit and push them/,
        ),
        `${name}, ${command}`,
      );
      assert.deepEqual(
        calls,
        stopsAt[command],
        `${name}, ${command}: nothing synced, linked, pulled or migrated`,
      );
    }
  }
});

test("F-49: a satellite's own checkout is checked when it is built, and the kit's only when it supplies migrations", async () => {
  const dirty = { changes: ["?? scratch.txt"] };

  // Built and promoted: the satellite checkout must be clean.
  for (const run of [deploy, up]) {
    const { cliRoot, appRoot } = fixture("satellite");
    const { runner, inspected } = recordingRunner({ trees: { [appRoot]: dirty } });
    await assert.rejects(run(cliRoot, {}, runner), unreleasable("deploy", /the satellite checkout has 1 .+/));
    assert.deepEqual(
      inspected.map((i) => i.root),
      [appRoot],
    );
  }

  // A satellite on the kit's database reads nothing from the kit checkout.
  const shared = fixture("satellite");
  const unread = recordingRunner({ trees: { [shared.kitRoot]: dirty } });
  await deploy(shared.cliRoot, {}, unread.runner);
  assert.deepEqual(
    unread.inspected.map((i) => i.root),
    [shared.appRoot],
  );

  // One that owns its database migrates from the kit checkout: both are read.
  const owned = fixture("satellite", { database: "own" });
  const migrating = recordingRunner({ trees: { [owned.kitRoot]: dirty } });
  await assert.rejects(
    deploy(owned.cliRoot, { databaseUrl: PRODUCTION_DIRECT }, migrating.runner),
    unreleasable("deploy", /the kit checkout has 1 .+/),
  );
  assert.deepEqual(migrating.calls, ["envCheck", "tree", "tree"]);
  assert.deepEqual(
    migrating.inspected,
    [
      { root: owned.appRoot, allowRef: undefined },
      { root: owned.kitRoot, allowRef: undefined },
    ],
    "both are read, the satellite's first",
  );

  // And `migrate` alone reads the kit checkout alone.
  const alone = recordingRunner({ trees: { [owned.kitRoot]: dirty } });
  await assert.rejects(
    migrateCommand(owned.cliRoot, { databaseUrl: PRODUCTION_DIRECT }, alone.runner),
    unreleasable("migrate", /the kit checkout has 1 .+/),
  );
  assert.deepEqual(
    alone.inspected.map((i) => i.root),
    [owned.kitRoot],
  );
});

/** A pushed pull request's branch, ahead of origin/main. */
const PR_TREE: FakeTree = {
  head: PR_SHA,
  branch: "feature/0007",
  pushedAs: ["origin/feature/0007"],
  refs: { "origin/main": MAIN_SHA, "origin/feature/0007": PR_SHA },
};

test("F-49: a satellite's own database is migrated only from the kit's default branch, by every command, and --allow-ref never reaches the kit", async () => {
  // The kit checkout sits on a PUSHED feature branch that adds 0007. The
  // kit's own `migrate` may run from it (§1.1). A satellite's production may
  // not: 0007 would be ledgered there under its checksum, and once review
  // changed it every later migrate of that database would abort.
  const offDefault = unreleasable(
    "(deploy|migrate)",
    /the kit checkout's HEAD 222222222222 is not origin\/main \(111111111111\)/,
    /No flag changes this\. --allow-ref names the satellite's ref, never the kit's\./,
  );
  const stopsAt: Record<string, string[]> = {
    deploy: ["envCheck", "tree", "tree"],
    up: ["tree", "tree"],
    migrate: ["tree"],
  };
  for (const [name, run] of Object.entries(COMMANDS)) {
    const { cliRoot, kitRoot } = fixture("satellite", { database: "own" });
    const { runner, calls } = recordingRunner({ trees: { [kitRoot]: PR_TREE } });
    await assert.rejects(run(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner), offDefault, name);
    assert.deepEqual(calls, stopsAt[name], `${name}: nothing synced, linked, pulled or migrated`);
  }

  // --allow-ref names the SATELLITE's ref (another repository), so it lets the
  // satellite checkout through and leaves the kit checkout where it was.
  const { cliRoot, appRoot, kitRoot } = fixture("satellite", { database: "own" });
  const named = recordingRunner({ trees: { [appRoot]: PR_TREE, [kitRoot]: PR_TREE } });
  await assert.rejects(
    deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, allowRef: "origin/feature/0007" }, named.runner),
    offDefault,
  );
  assert.deepEqual(named.inspected, [
    { root: appRoot, allowRef: "origin/feature/0007" },
    { root: kitRoot, allowRef: undefined },
  ]);

  // The satellite at that ref and the kit at its default branch: released.
  const released = recordingRunner({ trees: { [appRoot]: PR_TREE } });
  await deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, allowRef: "origin/feature/0007" }, released.runner);
  assert.deepEqual(released.calls, ["envCheck", "tree", ...KIT_ORDER.filter((s) => s !== "envCheck")]);
  const migrated = recordingRunner();
  await migrateCommand(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, migrated.runner);
  assert.deepEqual(migrated.calls, SATELLITE_MIGRATE_ORDER);

  // The kit's own `migrate` still runs from the same pushed branch.
  const kit = fixture("kit");
  const gate = recordingRunner({ trees: { [kit.kitRoot]: PR_TREE } });
  await migrateCommand(kit.cliRoot, { databaseUrl: PRODUCTION_DIRECT }, gate.runner);
  assert.deepEqual(gate.calls, MIGRATE_ORDER);
});

test("F-49: deploy and up promote only origin's default branch, unless --allow-ref names the pushed ref HEAD is", async () => {
  const offMain = /the kit checkout's HEAD 222222222222 is not origin\/main \(111111111111\)/;
  for (const [run, stopsAt] of [
    [deploy, ["envCheck", "tree"]],
    [up, ["tree"]],
  ] as const) {
    const { cliRoot, kitRoot } = fixture("kit");
    const { runner, calls } = recordingRunner({ trees: { [kitRoot]: PR_TREE } });
    await assert.rejects(
      run(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
      unreleasable("deploy", offMain, /--allow-ref <ref>[\s\S]*drk-deploy migrate/),
    );
    assert.deepEqual(calls, stopsAt);
  }

  // Named, it deploys, and the ref reached the check.
  const { cliRoot, kitRoot } = fixture("kit");
  const named = recordingRunner({ trees: { [kitRoot]: PR_TREE } });
  await deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, allowRef: "origin/feature/0007" }, named.runner);
  assert.deepEqual(named.calls, KIT_ORDER);
  assert.deepEqual(named.inspected, [{ root: kitRoot, allowRef: "origin/feature/0007" }]);
  const upped = recordingRunner({ trees: { [kitRoot]: PR_TREE } });
  await up(cliRoot, { databaseUrl: PRODUCTION_DIRECT, allowRef: "origin/feature/0007" }, upped.runner);
  assert.deepEqual(upped.calls, UP_ORDER);

  // It names a ref HEAD must BE, not a pass: another ref, or one that does
  // not resolve, is refused.
  const other = recordingRunner({ trees: { [kitRoot]: PR_TREE } });
  await assert.rejects(
    deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, allowRef: "origin/main" }, other.runner),
    unreleasable("deploy", offMain),
  );
  const unknown = recordingRunner({ trees: { [kitRoot]: PR_TREE } });
  await assert.rejects(
    deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, allowRef: "origin/nope" }, unknown.runner),
    unreleasable("deploy", /the kit checkout has no origin\/nope to compare HEAD with/),
  );

  // And it never lets an unpushed or dirty checkout through.
  const local = recordingRunner({
    trees: {
      [kitRoot]: { ...PR_TREE, pushedAs: [], changes: ["?? notes.txt"], refs: { "feature/0007": PR_SHA } },
    },
  });
  await assert.rejects(
    deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, allowRef: "feature/0007" }, local.runner),
    unreleasable(
      "deploy",
      /the kit checkout has 1 uncommitted change\(s\).+; the kit checkout's HEAD .+ is not pushed.+/,
    ),
  );

  // A "ref" git would read as an option is refused before anything is read.
  const option = recordingRunner();
  await assert.rejects(
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, allowRef: "--output=x" }, option.runner),
    refusal(/^--allow-ref "--output=x" is not a ref\.$/, /origin\/hotfix/, 2),
  );
  assert.deepEqual(option.calls, ["envCheck"]);
});

test("F-49: migrate runs from a pushed pull request's branch (the pre-merge gate), and refuses an unpushed commit", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const gate = recordingRunner({ trees: { [kitRoot]: PR_TREE }, git: GIT_CONNECTED });
  await migrateCommand(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, gate.runner);
  assert.deepEqual(gate.calls, MIGRATE_ORDER, "the git integration is never asked: migrate promotes nothing");

  for (const [name, tree] of [
    ["committed, not pushed", { ...PR_TREE, pushedAs: [] }],
    ["detached at a commit no remote branch has", { ...PR_TREE, branch: null, pushedAs: [] }],
  ] as const) {
    const { runner, calls } = recordingRunner({ trees: { [kitRoot]: tree } });
    await assert.rejects(
      migrateCommand(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner),
      unreleasable("migrate", /the kit checkout's HEAD 222222222222.* is not pushed: .+/, /git push/),
      name,
    );
    assert.deepEqual(calls, ["tree"], `${name}: nothing linked, pulled or migrated`);
  }

  const outside = recordingRunner({
    trees: { [kitRoot]: { notRepository: "fatal: not a git repository", head: null, pushedAs: [] } },
  });
  await assert.rejects(
    migrateCommand(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, outside.runner),
    unreleasable("migrate", /the kit checkout \(.+\) is not a git checkout/, /git says: fatal/),
  );
});

/** A string, as a RegExp source that matches it literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("F-49: the commit is printed before anything runs and again next to the database it migrates", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const fake = recordingRunner({ trees: { [kitRoot]: PR_TREE } });
  let beforeMigrate = "";
  const { error, out } = await captureOutput((soFar) =>
    migrateCommand(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, {
      ...(fake.runner as object),
      migrate: async (...received: unknown[]) => {
        beforeMigrate = soFar();
        return (fake.runner as { migrate: (...a: unknown[]) => Promise<void> }).migrate(...received);
      },
    } as never),
  );
  assert.equal(error, undefined, out);
  const recorded = literal(`${PR_SHA} (on feature/0007, clean tree, pushed as origin/feature/0007)`);
  assert.match(beforeMigrate, new RegExp(`Release commit \\(kit checkout\\)[\\s\\S]*commit\\s+${recorded}`));
  assert.match(
    beforeMigrate,
    new RegExp(`Migration target[\\s\\S]*from commit\\s+${recorded}`),
    "printed where the migration is, before it runs",
  );

  // A promotion prints the release ref it was compared with, and says it was not fetched.
  const promoted = await captureOutput(() =>
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, recordingRunner().runner),
  );
  assert.equal(promoted.error, undefined, promoted.out);
  assert.match(
    promoted.out,
    /release ref\s+origin\/main at 111111111111 \(as last fetched: nothing is fetched\)/,
  );
});

test("F-49: a dry run reads and reports the tree, and refuses nothing", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const dirty = { [kitRoot]: { ...PR_TREE, changes: [`?? ${MIGRATION_0007}`] } };

  const deployed = recordingRunner({ trees: dirty, git: GIT_CONNECTED });
  const shown = await captureOutput(() =>
    deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, dryRun: true }, deployed.runner),
  );
  assert.equal(shown.error, undefined, shown.out);
  assert.deepEqual(deployed.calls, ["envCheck", ...GATE, "migrate"]);
  assert.match(shown.out, /\[dry-run\] a real run would refuse: the kit checkout has 1 uncommitted change/);
  assert.match(
    shown.out,
    /\[dry-run\] a real run would refuse: the kit checkout's HEAD 222222222222 is not origin\/main/,
  );
  assert.match(
    shown.out,
    /\[dry-run\] a real run would refuse: Refusing to deploy: Vercel's git integration/,
  );

  const migrated = recordingRunner({ trees: dirty });
  const planned = await captureOutput(() =>
    migrateCommand(cliRoot, { databaseUrl: PRODUCTION_DIRECT, dryRun: true }, migrated.runner),
  );
  assert.equal(planned.error, undefined, planned.out);
  assert.deepEqual(migrated.calls, ["tree", "migrate"]);
  assert.match(planned.out, /\[dry-run\] a real run would refuse: the kit checkout has 1 uncommitted change/);
});

test("F-49: a dry run that cannot read the project's git connection says so and plans on; a real run stops", async () => {
  // The git connection comes from the Vercel API, which a dry run now reads.
  // An API that is down must not turn "show me the plan" into a failure.
  const unreadable =
    /\[dry-run\] could not read the project \(project failed\), so whether it is the SSO issuer's own project and whether Vercel also deploys production are unknown/;
  const dry = recordingRunner({ failAt: "project" });
  const shown = await captureOutput(() =>
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, dryRun: true }, dry.runner),
  );
  assert.equal(shown.error, undefined, shown.out);
  assert.deepEqual(dry.calls, ["envCheck", ...GATE, "migrate"]);
  assert.match(shown.out, unreadable);
  const dryUp = recordingRunner({ failAt: "project" });
  const upShown = await captureOutput(() =>
    up(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, dryRun: true }, dryUp.runner),
  );
  assert.equal(upShown.error, undefined, upShown.out);
  assert.deepEqual(dryUp.calls, [...GATE, "envSync", "migrate"]);
  assert.match(upShown.out, unreadable);

  // A real run cannot tell whether it races Vercel, so it goes no further.
  for (const run of [deploy, up]) {
    const real = recordingRunner({ failAt: "project" });
    await assert.rejects(
      run(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, real.runner),
      /^Error: project failed$/,
    );
    assert.deepEqual(real.calls.at(-1), "project", "nothing synced, linked, pulled or migrated");
  }
});

test("F-49: a run that migrates is refused while Vercel's git integration deploys production, unless named", async () => {
  const raced = refusal(
    /^Refusing to deploy: Vercel's git integration also deploys this project's production \(github:devresponse\/devresponsekit: every push to main is built and promoted by Vercel\)\. Nothing was changed\.$/,
    /"deploymentEnabled": \{ "main": false \}[\s\S]*--allow-git-integration-race[\s\S]*`drk-deploy migrate` is not refused/,
    2,
  );
  const deployed = recordingRunner({ git: GIT_CONNECTED });
  await assert.rejects(
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, deployed.runner),
    raced,
  );
  assert.deepEqual(deployed.calls, ["envCheck", ...CHECKS], "nothing linked, pulled or migrated");
  const upped = recordingRunner({ git: GIT_CONNECTED });
  await assert.rejects(up(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, upped.runner), raced);
  assert.deepEqual(upped.calls, CHECKS, "refused before env:sync wrote anything");

  // Named, it runs in the usual order, and says what it is doing.
  const allowed = recordingRunner({ git: GIT_CONNECTED });
  const loud = await captureOutput(() =>
    deploy(
      fixture("kit").cliRoot,
      { databaseUrl: PRODUCTION_DIRECT, allowGitIntegrationRace: true },
      allowed.runner,
    ),
  );
  assert.equal(loud.error, undefined, loud.out);
  assert.deepEqual(allowed.calls, KIT_ORDER);
  assert.match(loud.out, /--allow-git-integration-race: Vercel ALSO promotes every push to production/);
  const allowedUp = recordingRunner({ git: GIT_CONNECTED });
  await up(
    fixture("kit").cliRoot,
    { databaseUrl: PRODUCTION_DIRECT, allowGitIntegrationRace: true },
    allowedUp.runner,
  );
  assert.deepEqual(allowedUp.calls, UP_ORDER);

  // With no migrate step there is no order to lose: it deploys, and says so.
  const noMigrate: [string, string, Record<string, unknown>][] = [
    ["deploy --skip-migrations", fixture("kit").cliRoot, { skipMigrations: true }],
    ["a satellite on the kit's database", fixture("satellite").cliRoot, {}],
  ];
  for (const [name, cliRoot, options] of noMigrate) {
    const { runner, calls } = recordingRunner({ git: GIT_CONNECTED });
    const told = await captureOutput(() => deploy(cliRoot, options, runner));
    assert.equal(told.error, undefined, `${name}: ${told.out}`);
    assert.deepEqual(
      calls,
      KIT_ORDER.filter((s) => s !== "migrate"),
      name,
    );
    assert.match(told.out, /two deployers of the same code, not a race/, name);
  }

  // Auto-deploy turned off where this can tell: in vercel.json, or an Ignored
  // Build Step that skips every build.
  const off: [string, ProjectGit, unknown][] = [
    ["vercel.json, the production branch", GIT_CONNECTED, { git: { deploymentEnabled: { main: false } } }],
    ["vercel.json, every branch", GIT_CONNECTED, { git: { deploymentEnabled: false } }],
    ["Ignored Build Step exit 0", { ...GIT_CONNECTED, ignoreCommand: "exit 0" }, null],
  ];
  for (const [name, git, vercelJson] of off) {
    const { cliRoot, kitRoot } = fixture("kit");
    if (vercelJson) writeFileSync(join(kitRoot, "vercel.json"), JSON.stringify(vercelJson));
    const { runner, calls } = recordingRunner({ git });
    await deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, runner);
    assert.deepEqual(calls, KIT_ORDER, name);
  }

  // Any other Ignored Build Step is a program this cannot run: it counts as
  // on, and is named.
  const custom = recordingRunner({ git: { ...GIT_CONNECTED, ignoreCommand: "bash scripts/ignore.sh" } });
  await assert.rejects(
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, custom.runner),
    refusal(
      /unless its Ignored Build Step \(`bash scripts\/ignore\.sh`\), which this cannot evaluate, skips it\)/,
    ),
  );
});

test("F-49: productionAutoDeploy and projectGit read the project's git connection, and count only what they can be sure of as off", () => {
  const cases: [string, ProjectGit, unknown, boolean][] = [
    ["nothing connected", NO_GIT, null, false],
    ["connected", GIT_CONNECTED, null, true],
    [
      "connected, another branch disabled",
      GIT_CONNECTED,
      { git: { deploymentEnabled: { dev: false } } },
      true,
    ],
    [
      "connected, a glob is not evaluated",
      GIT_CONNECTED,
      { git: { deploymentEnabled: { "*": false } } },
      true,
    ],
    ["connected, main disabled", GIT_CONNECTED, { git: { deploymentEnabled: { main: false } } }, false],
    [
      "connected on another production branch",
      { ...GIT_CONNECTED, productionBranch: "release" },
      { git: { deploymentEnabled: { release: false } } },
      false,
    ],
    ["every build ignored", { ...GIT_CONNECTED, ignoreCommand: " exit 0 " }, null, false],
    ["an ignore step that can build", { ...GIT_CONNECTED, ignoreCommand: "exit 1" }, null, true],
  ];
  for (const [name, git, vercelJson, on] of cases) {
    assert.equal(productionAutoDeploy(git, vercelJson).on, on, name);
  }

  assert.deepEqual(projectGit(undefined, undefined), NO_GIT);
  assert.deepEqual(projectGit(null, "  "), NO_GIT, "a blank ignore command is none");
  assert.deepEqual(
    projectGit(
      { type: "github", org: "devresponse", repo: "devresponsekit", productionBranch: "main" },
      null,
    ),
    GIT_CONNECTED,
  );
  assert.deepEqual(
    projectGit(
      { type: "gitlab", projectNameWithNamespace: "acme / kit", productionBranch: "trunk" },
      "exit 0",
    ),
    { repository: "gitlab:acme / kit", productionBranch: "trunk", ignoreCommand: "exit 0" },
  );
  assert.equal(
    projectGit({ type: "bitbucket", owner: "acme", slug: "kit", productionBranch: "main" }, null).repository,
    "bitbucket:acme/kit",
  );
});

test("F-49: doctor counts a checkout every release command refuses, and only notes one that is off the release ref", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const { main } = pushedCheckout(kitRoot);
  const run = async () => {
    const report = await captureOutput(() => doctor(cliRoot));
    assert.equal(report.error, undefined, report.out);
    return { problems: report.result as number, out: report.out };
  };

  // The fixture has no Vercel CLI installed and the API is offline, so the
  // count is never zero: what matters is what the checkout adds to it.
  const clean = await run();
  assert.match(
    clean.out,
    new RegExp(`kit checkout\\s+ok ${main} \\(on main, clean tree, pushed as origin/main\\)`),
  );

  writeFileSync(join(kitRoot, MIGRATION_0007), "create table foo ();\n");
  const dirty = await run();
  assert.equal(dirty.problems, clean.problems + 1, dirty.out);
  assert.match(
    dirty.out,
    /kit checkout\s+wrong — the kit checkout has 1 uncommitted change\(s\), untracked files included: \?\? src\/db\/migrations\/0007-foo\.sql/,
  );

  gitFixture(kitRoot, "switch", "--quiet", "-c", "feature/0007");
  gitFixture(kitRoot, "add", "-A");
  gitFixture(kitRoot, "commit", "--quiet", "-m", "0007");
  const unpushed = await run();
  assert.equal(unpushed.problems, clean.problems + 1, unpushed.out);
  assert.match(
    unpushed.out,
    /kit checkout\s+wrong — the kit checkout's HEAD \w{12} \(feature\/0007\) is not pushed/,
  );

  // Pushed, it is what `migrate` runs from before the merge: not a problem.
  gitFixture(kitRoot, "push", "--quiet", "-u", "origin", "feature/0007");
  const pr = await run();
  assert.equal(pr.problems, clean.problems, pr.out);
  assert.match(
    pr.out,
    /release ref\s+HEAD is not origin\/main \(\w{12}\) — deploy and up refuse it without --allow-ref; migrate allows it/,
  );
});

/*
 * next-env.d.ts as the kit commits it (the `next dev` form) and as `next
 * build` rewrites it: Next 16's writeAppTypeDeclarations with distDir ".next"
 * instead of ".next/dev". `vercel build`, which deploy and up run in the
 * checkout, runs `next build`, so every deploy produced the second form.
 */
const NEXT_ENV_DEV = [
  '/// <reference types="next" />',
  '/// <reference types="next/image-types/global" />',
  'import "./.next/dev/types/routes.d.ts";',
  'import "./.next/dev/types/root-params.d.ts";',
  "",
  "// NOTE: This file should not be edited",
  "// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.",
  "",
].join("\n");
const NEXT_ENV_BUILD = NEXT_ENV_DEV.replaceAll("./.next/dev/types/", "./.next/types/");

test("F-49: readStatus reads git's -z porcelain unquoted, and sets aside only a working-tree next-env.d.ts", () => {
  const { changes, generated } = readStatus(
    [
      "R  src/db/migrations/0007-new.sql",
      "src/db/migrations/0007-old.sql",
      " M next-env.d.ts",
      " M app one/next-env.d.ts",
      "?? notes with spaces.txt",
      "M  apps/b/next-env.d.ts",
      "MM apps/c/next-env.d.ts",
      " D apps/d/next-env.d.ts",
      "?? apps/e/next-env.d.ts",
      " M my-next-env.d.ts",
      " M next-env.d.ts.bak",
      "",
    ].join("\0"),
  );
  assert.deepEqual(generated, ["next-env.d.ts", "app one/next-env.d.ts"]);
  assert.deepEqual(changes, [
    "R  src/db/migrations/0007-old.sql -> src/db/migrations/0007-new.sql",
    "?? notes with spaces.txt",
    "M  apps/b/next-env.d.ts",
    "MM apps/c/next-env.d.ts",
    " D apps/d/next-env.d.ts",
    "?? apps/e/next-env.d.ts",
    " M my-next-env.d.ts",
    " M next-env.d.ts.bak",
  ]);
  assert.deepEqual(readStatus(""), { changes: [], generated: [] });
});

test("F-49: a next-env.d.ts a build rewrote is set aside and named in a real checkout; anything a person did to it counts", async () => {
  const { work } = pushedCheckout();
  commitFile(work, "next-env.d.ts", NEXT_ENV_DEV);
  commitFile(work, "app one/next-env.d.ts", NEXT_ENV_DEV);
  gitFixture(work, "push", "--quiet", "origin", "main");

  // `next build` in the checkout, and in another app of the same repository.
  writeFileSync(join(work, "next-env.d.ts"), NEXT_ENV_BUILD);
  writeFileSync(join(work, "app one", "next-env.d.ts"), NEXT_ENV_BUILD);
  const built = await inspectTree(work);
  assert.deepEqual(built.changes, []);
  assert.deepEqual([...built.generated].sort(), ["app one/next-env.d.ts", "next-env.d.ts"]);
  assert.deepEqual(treeProblems(built, { label: "kit checkout", rule: "release" }), []);
  assert.match(
    describeCommit(built),
    /\(on main, clean tree apart from (app one\/)?next-env\.d\.ts and (app one\/)?next-env\.d\.ts, pushed as origin\/main\)$/,
    "the record still says it",
  );
  // Read from inside the app folder, the paths are still the repository's.
  assert.deepEqual([...(await inspectTree(join(work, "app one"))).generated].sort(), [
    "app one/next-env.d.ts",
    "next-env.d.ts",
  ]);

  // Staged is something a person did: it counts. An edit beside it counts
  // too, with its path unquoted although it has a space in it.
  gitFixture(work, "add", "next-env.d.ts");
  writeFileSync(join(work, "app one", "notes on 0007.txt"), "x\n");
  const staged = await inspectTree(work);
  assert.deepEqual(staged.changes, ["M  next-env.d.ts", "?? app one/notes on 0007.txt"]);
  assert.deepEqual(staged.generated, ["app one/next-env.d.ts"]);
  assert.equal(treeProblems(staged, { label: "kit checkout", rule: "release" }).length, 1);
});

/**
 * A kit fixture whose checkout is a real, pushed git repository holding the
 * dev form of next-env.d.ts and ignoring `.vercel` (where the fake link and
 * pull write), as the kit does.
 */
function pushedKitWithNextEnv(): { cliRoot: string; kitRoot: string } {
  const { cliRoot, kitRoot } = fixture("kit");
  pushedCheckout(kitRoot);
  commitFile(kitRoot, ".gitignore", ".vercel\n");
  commitFile(kitRoot, "next-env.d.ts", NEXT_ENV_DEV);
  gitFixture(kitRoot, "push", "--quiet", "origin", "main");
  return { cliRoot, kitRoot };
}

/** The recording fake, with the REAL `inspectTree` and a `build` that rewrites next-env.d.ts as `next build` does. */
function buildingRunner(options: { failAt?: string } = {}) {
  const fake = recordingRunner(options);
  const steps = fake.runner as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const runner = {
    ...steps,
    tree: async (root: string, allowRef?: string) => {
      await steps.tree!(root, allowRef);
      return inspectTree(root, allowRef);
    },
    build: async (vercel: { root: string }) => {
      writeFileSync(join(vercel.root, "next-env.d.ts"), NEXT_ENV_BUILD);
      return steps.build!(vercel);
    },
  };
  return { ...fake, runner: runner as never };
}

test("F-49: deploy's own build leaves next-env.d.ts as it found it, and a rewritten one does not stop the next run", async () => {
  const { cliRoot, kitRoot } = pushedKitWithNextEnv();
  const nextEnv = () => readFileSync(join(kitRoot, "next-env.d.ts"), "utf8");

  const first = buildingRunner();
  await deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, first.runner);
  assert.deepEqual(first.calls, KIT_ORDER);
  assert.equal(nextEnv(), NEXT_ENV_DEV, "put back after the build");
  assert.equal(gitFixture(kitRoot, "status", "--porcelain"), "", "the run leaves the checkout clean");

  // So a second run is released, not refused, and up's build is put back too.
  const second = buildingRunner();
  await up(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, second.runner);
  assert.deepEqual(second.calls, UP_ORDER);
  assert.equal(nextEnv(), NEXT_ENV_DEV);

  // A build that fails after rewriting it puts it back as well, and promotes nothing.
  const failed = buildingRunner({ failAt: "build" });
  await assert.rejects(deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, failed.runner), /build failed/);
  assert.equal(failed.calls.includes("promote"), false);
  assert.equal(nextEnv(), NEXT_ENV_DEV);

  // A local `next build` before the run: set aside and named, not refused,
  // and left the way the run found it.
  writeFileSync(join(kitRoot, "next-env.d.ts"), NEXT_ENV_BUILD);
  const local = buildingRunner();
  const shown = await captureOutput(() => deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT }, local.runner));
  assert.equal(shown.error, undefined, shown.out);
  assert.deepEqual(local.calls, KIT_ORDER);
  assert.match(
    shown.out,
    /set aside\s+next-env\.d\.ts \(modified, set aside: every `next build` rewrites it from the app's config/,
  );
  assert.match(
    shown.out,
    /commit\s+\w{40} \(on main, clean tree apart from next-env\.d\.ts, pushed as origin\/main\)/,
  );
  assert.equal(nextEnv(), NEXT_ENV_BUILD);
});

test("F-49: doctor counts a satellite's kit checkout off the kit's default branch, and names a set-aside next-env.d.ts", async () => {
  const { cliRoot, kitRoot, appRoot } = fixture("satellite", { database: "own" });
  pushedCheckout(kitRoot);
  pushedCheckout(appRoot);
  commitFile(appRoot, "next-env.d.ts", NEXT_ENV_DEV);
  gitFixture(appRoot, "push", "--quiet", "origin", "main");
  const run = async () => {
    const report = await captureOutput(() => doctor(cliRoot));
    assert.equal(report.error, undefined, report.out);
    return { problems: report.result as number, out: report.out };
  };

  const clean = await run();
  assert.match(clean.out, /satellite checkout\s+ok \w{40} \(on main, clean tree, pushed as origin\/main\)/);
  assert.match(clean.out, /kit checkout\s+ok \w{40} \(on main, clean tree, pushed as origin\/main\)/);

  // A build of the satellite rewrote its next-env.d.ts: named, not counted.
  writeFileSync(join(appRoot, "next-env.d.ts"), NEXT_ENV_BUILD);
  const built = await run();
  assert.equal(built.problems, clean.problems, built.out);
  assert.match(built.out, /set aside\s+next-env\.d\.ts \(modified, set aside/);

  // The kit checkout on a pushed feature branch: every command that migrates
  // this satellite's database from it refuses that, and no flag moves it.
  gitFixture(kitRoot, "switch", "--quiet", "-c", "feature/0007");
  commitFile(kitRoot, MIGRATION_0007, "create table foo ();\n");
  gitFixture(kitRoot, "push", "--quiet", "-u", "origin", "feature/0007");
  const off = await run();
  assert.equal(off.problems, clean.problems + 1, off.out);
  assert.match(
    off.out,
    /kit checkout\s+wrong — the kit checkout's HEAD \w{12} is not origin\/main \(\w{12}\)/,
  );
  assert.match(off.out, /--allow-ref names the satellite's ref, never the kit's/);
});

/* ================================================================== */
/*  F-50: one config per deployment, and never the issuer's project    */
/* ================================================================== */

/** The kit's origin in every F-50 fixture, and so every satellite's SSO issuer. */
const ISSUER = "https://demo.example.com";

/** A satellite app folder as `assertSatelliteRoot` accepts one: a build, a consume route, the refusal stub. */
function satelliteCheckout(root: string, name: string): string {
  mkdirSync(join(root, "src", "app", "api", "sso", "consume"), { recursive: true });
  const stub = "node scripts/db-owned-by-kit.mjs";
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name,
      scripts: { build: "next build", "db:app:migrate": stub, "db:auth:migrate": stub },
    }),
  );
  return root;
}

/**
 * The projects `GET /v9/projects/{idOrName}` answers, by id or name, each with
 * its production aliases, in the shape the SDK validates. Any other call
 * throws, and every request is recorded.
 */
function fakeProjects(projects: Record<string, { name: string; aliases: string[] }>): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, request?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(
      `${request?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}${url.search}`,
    );
    const match = url.hostname === "api.vercel.com" ? /^\/v9\/projects\/([^/]+)$/.exec(url.pathname) : null;
    const ref = match ? decodeURIComponent(match[1]!) : "";
    const found = Object.entries(projects).find(([id, project]) => id === ref || project.name === ref);
    if (!found) throw new Error(`an F-50 test made an unexpected call: ${url}`);
    const [id, { name, aliases }] = found;
    return new Response(
      JSON.stringify({
        id,
        name,
        accountId: "team_test",
        alias: aliases.map((domain) => ({
          domain,
          environment: "production",
          target: "PRODUCTION",
          deployment: null,
        })),
        nodeVersion: "24.x",
        defaultResourceConfig: { functionDefaultRegions: [] },
        resourceConfig: { functionDefaultRegions: [] },
        deploymentExpiration: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return requests;
}

/** The fleet as the Vercel API sees it: two satellites' projects, a spare, and the kit's. */
const FLEET = {
  prj_standalone: { name: "app-standalone", aliases: ["app1.example.net", "app-standalone.vercel.app"] },
  prj_handoff: { name: "app-handoff", aliases: ["app2.example.net"] },
  prj_moved: { name: "app-standalone-2", aliases: ["app1-new.example.net"] },
  prj_kit: { name: "devresponsekit", aliases: ["demo.example.com", "devresponsekit.vercel.app"] },
};

/** A CLI root with no config yet, a kit checkout `init` accepts, and the two satellites' app folders. */
function fleetRoot(): { cliRoot: string; kitRoot: string; standalone: string; handoff: string } {
  const { cliRoot, kitRoot } = fixture("kit", { migratableKit: true });
  rmSync(join(cliRoot, ".drk-deploy.json"));
  return {
    cliRoot,
    kitRoot,
    standalone: satelliteCheckout(join(cliRoot, "app-standalone"), "app-standalone"),
    handoff: satelliteCheckout(join(cliRoot, "app-handoff"), "app-handoff"),
  };
}

/** app-standalone, as a first `init` records it: its own project, on its own database. */
async function initStandalone(fleet: ReturnType<typeof fleetRoot>): Promise<void> {
  await init(fleet.cliRoot, {
    project: "prj_standalone",
    domain: "app1.example.net",
    appName: "Standalone",
    satellite: "standalone",
    appRoot: fleet.standalone,
    issuer: ISSUER,
    kitRoot: fleet.kitRoot,
    ownDatabase: true,
    yes: true,
  });
}

const configText = (cliRoot: string) => readFileSync(join(cliRoot, ".drk-deploy.json"), "utf8");

test("F-50: init refuses to carry one deployment's project, domain and app id into another", async () => {
  const requests = fakeProjects(FLEET);
  try {
    const fleet = fleetRoot();
    await initStandalone(fleet);
    const recorded = configText(fleet.cliRoot);
    assert.equal(configOf(fleet.cliRoot).satellite.database, "own");

    // The recorded scenario: app-handoff configured over app-standalone's file
    // with no --project. It used to build app-handoff into app-standalone's
    // project, domain and application id, and `up` then replaced
    // app-standalone's production.
    const cases: [string, Record<string, unknown>, RegExp, RegExp][] = [
      [
        "a new option and checkout",
        { satellite: "handoff", appRoot: fleet.handoff, issuer: ISSUER, yes: true },
        /its satellite option is standalone, and this run names handoff; its app checkout is .+app-standalone, and this run names .+app-handoff\./,
        /pass --project <name\|id>, --domain <host>, --application-id <id>, --kit-database or --own-database\.$/,
      ],
      [
        // The verifier's sibling: the option alone kept the other app's checkout too.
        "a new option alone",
        { satellite: "handoff", yes: true },
        /its satellite option is standalone, and this run names handoff\./,
        /--application-id <id>, --app-root <path>, --kit-database or --own-database\.$/,
      ],
      [
        "a new checkout alone",
        { appRoot: fleet.handoff, project: "prj_handoff", domain: "app2.example.net", yes: true },
        /its app checkout is .+app-standalone, and this run names .+app-handoff\./,
        /pass --application-id <id>, --satellite <standalone\|handoff\|shared>, --kit-database or --own-database\.$/,
      ],
    ];
    for (const [name, options, what, missing] of cases) {
      requests.length = 0;
      await assert.rejects(
        init(fleet.cliRoot, options),
        (err: unknown) =>
          err instanceof CliError &&
          err.message.startsWith(`${configPath(fleet.cliRoot)} records another deployment: `) &&
          what.test(err.message) &&
          missing.test(err.message) &&
          /--config \.drk-deploy\.<name>\.json/.test(err.hint ?? ""),
        name,
      );
      assert.equal(configText(fleet.cliRoot), recorded, `${name}: the file is untouched`);
      assert.deepEqual(requests, [], `${name}: refused before any call`);
    }

    // Named in full, it is configured, and nothing of app-standalone's own
    // carries over: not its database, not its product name. The issuer and
    // the audience prefix are the fleet's and are kept.
    await init(fleet.cliRoot, {
      project: "prj_handoff",
      domain: "app2.example.net",
      applicationId: "handoff",
      satellite: "handoff",
      appRoot: fleet.handoff,
      kitDatabase: true,
      yes: true,
    });
    const handoff = configOf(fleet.cliRoot);
    assert.equal(handoff.projectId, "prj_handoff");
    assert.equal(handoff.origin, "https://app2.example.net");
    assert.equal(handoff.applicationId, "handoff");
    assert.equal(handoff.appName, "app-handoff", "the new project's name, not app-standalone's product name");
    assert.equal(handoff.audiencePrefix, "devresponse-app");
    assert.deepEqual(handoff.satellite, {
      option: "handoff",
      appRoot: fleet.handoff,
      issuerOrigin: ISSUER,
      database: "shared-with-kit",
    });

    // A kit config turned into a satellite: the same rule, and the kit's
    // project is never inherited.
    const kit = fleetRoot();
    await init(kit.cliRoot, {
      project: "prj_kit",
      domain: "demo.example.com",
      kitRoot: kit.kitRoot,
      yes: true,
    });
    const kitRecorded = configText(kit.cliRoot);
    requests.length = 0;
    await assert.rejects(
      init(kit.cliRoot, { satellite: "standalone", appRoot: kit.standalone, issuer: ISSUER, yes: true }),
      refusal(
        /records another deployment: it is the kit's, and this run makes it a satellite\. A new deployment is named in full: pass --project <name\|id>, --domain <host>, --application-id <id>, --kit-database or --own-database\.$/,
      ),
    );
    assert.equal(configText(kit.cliRoot), kitRecorded);
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = offline;
  }
});

test("F-50: a re-run for the same deployment keeps every recorded value; a new project does not keep the old domain", async () => {
  fakeProjects(FLEET);
  try {
    const fleet = fleetRoot();
    await initStandalone(fleet);
    const recorded = configOf(fleet.cliRoot);

    // `init --yes` is the documented refresh (F-48), and naming the same
    // option and checkout again is the same deployment.
    for (const options of [
      { yes: true },
      { satellite: "standalone", appRoot: fleet.standalone, yes: true },
      { satellite: "standalone", appRoot: join(fleet.standalone, "."), yes: true },
    ]) {
      await init(fleet.cliRoot, options);
      assert.deepEqual(configOf(fleet.cliRoot), recorded, JSON.stringify(options));
    }

    // The recorded origin was the recorded project's domain: a re-run naming
    // another project takes the new one's, as a first init does. The app's
    // own settings stay.
    await init(fleet.cliRoot, { project: "prj_moved", yes: true });
    const moved = configOf(fleet.cliRoot);
    assert.equal(moved.projectId, "prj_moved");
    assert.equal(moved.origin, "https://app1-new.example.net");
    assert.equal(moved.applicationId, "standalone");
    assert.equal(moved.appName, "Standalone");
    assert.equal(moved.satellite.database, "own");
  } finally {
    globalThis.fetch = offline;
  }
});

const issuersProject = (hint: RegExp = /./) =>
  refusal(
    /^This satellite config points at the SSO issuer's own Vercel project: devresponsekit \(prj_kit\) serves demo\.example\.com, the SSO issuer's host, so it is the kit's project\. Nothing was changed\.$/,
    hint,
    2,
  );

test("F-50: init never saves a satellite config bound to the SSO issuer's own project", async () => {
  fakeProjects(FLEET);
  try {
    // The verifier's route (b): "back to the kit" with --project on a
    // satellite config, which stays a satellite. With --domain it reached the
    // kit's project; without it the kit's own domain is now inferred, which
    // the issuer check refuses first.
    const fleet = fleetRoot();
    await initStandalone(fleet);
    const recorded = configText(fleet.cliRoot);
    await assert.rejects(
      init(fleet.cliRoot, { project: "prj_kit", domain: "app1.example.net", yes: true }),
      issuersProject(/No flag overrides this, not --yes and not --skip-checks/),
    );
    await assert.rejects(
      init(fleet.cliRoot, { project: "prj_kit", yes: true }),
      refusal(/^The SSO issuer must not be this deployment's own origin\.$/),
    );
    assert.equal(configText(fleet.cliRoot), recorded, "the file is untouched");

    // A first init straight onto the kit's project writes nothing.
    const fresh = fleetRoot();
    await assert.rejects(
      init(fresh.cliRoot, {
        project: "prj_kit",
        domain: "app9.example.net",
        satellite: "standalone",
        appRoot: fresh.standalone,
        issuer: ISSUER,
        kitRoot: fresh.kitRoot,
        yes: true,
      }),
      issuersProject(),
    );
    assert.equal(existsSync(join(fresh.cliRoot, ".drk-deploy.json")), false);

    // The kit on its own project is what the kit is.
    const kit = fleetRoot();
    await init(kit.cliRoot, {
      project: "prj_kit",
      domain: "demo.example.com",
      kitRoot: kit.kitRoot,
      yes: true,
    });
    assert.equal(configOf(kit.cliRoot).projectId, "prj_kit");
  } finally {
    globalThis.fetch = offline;
  }
});

test("F-50: issuerProjectProblem recognises the issuer's project by its host, and nothing looser", () => {
  const satellite = resolveProfile(configOf(fixture("satellite").cliRoot));
  const kit = resolveProfile(configOf(fixture("kit").cliRoot));
  const project = (aliases: string[]) => ({ id: "prj_x", name: "x", aliases });
  const cases: [string, Parameters<typeof issuerProjectProblem>[1], boolean][] = [
    ["its own aliases", { project: project(["app1.example.net", "x.vercel.app"]) }, false],
    ["no aliases reported", { project: project([]) }, false],
    ["the issuer's host", { project: project(["x.vercel.app", "demo.example.com"]) }, true],
    ["another casing, a trailing dot", { project: project(["DEMO.Example.COM."]) }, true],
    ["written as a URL", { project: project(["https://demo.example.com/"]) }, true],
    ["a host that merely ends with it", { project: project(["evil-demo.example.com"]) }, false],
    ["a host that merely starts with it", { project: project(["demo.example.com.evil.net"]) }, false],
    ["a parent of it", { project: project(["example.com"]) }, false],
    [
      "BETTER_AUTH_URL stored readable as the issuer's origin",
      { project: project([]), env: [{ key: "BETTER_AUTH_URL", value: "https://demo.example.com/" }] },
      true,
    ],
    [
      "NEXT_PUBLIC_APP_URL stored readable as the issuer's origin",
      { project: project([]), env: [{ key: "NEXT_PUBLIC_APP_URL", value: "https://demo.example.com" }] },
      true,
    ],
    [
      // Every satellite stores this as the kit's origin: that is its job.
      "SSO_HANDOFF_ISSUER as the issuer's origin",
      { project: project([]), env: [{ key: "SSO_HANDOFF_ISSUER", value: "https://demo.example.com" }] },
      false,
    ],
    [
      "BETTER_AUTH_URL unreadable",
      { project: project([]), env: [{ key: "BETTER_AUTH_URL", value: undefined }] },
      false,
    ],
  ];
  for (const [name, evidence, refused] of cases) {
    assert.equal(issuerProjectProblem(satellite, evidence) !== null, refused, name);
    assert.equal(issuerProjectProblem(kit, evidence), null, `${name}: the kit IS the issuer`);
  }
});

test("F-50: deploy, up and migrate refuse a satellite config on the issuer's project before anything writes, --yes and --skip-checks included", async () => {
  const kitAliases = { aliases: ["devresponsekit.vercel.app", "demo.example.com"] };
  const refused = refusal(
    /^This satellite config points at the SSO issuer's own Vercel project: sat \(prj_sat\) serves demo\.example\.com/,
    /No flag overrides this, not --yes and not --skip-checks/,
    2,
  );
  const owned = { database: "own" } as const;
  const cases: [string, (runner: never) => Promise<void>, string[]][] = [
    // env:check finds 3 problems here, and --yes deploys past them.
    ["deploy --yes", (r) => deploy(fixture("satellite").cliRoot, { yes: true }, r), ["envCheck", ...CHECKS]],
    ["deploy --skip-checks", (r) => deploy(fixture("satellite").cliRoot, { skipChecks: true }, r), CHECKS],
    [
      "deploy with every flag that skips something",
      (r) =>
        deploy(
          fixture("satellite", owned).cliRoot,
          { yes: true, skipChecks: true, skipMigrations: true, allowGitIntegrationRace: true },
          r,
        ),
      CHECKS,
    ],
    ["up --yes", (r) => up(fixture("satellite").cliRoot, { yes: true }, r), CHECKS],
    [
      "deploy, a satellite that owns its database",
      (r) => deploy(fixture("satellite", owned).cliRoot, { databaseUrl: PRODUCTION_DIRECT, yes: true }, r),
      ["envCheck", "tree", "tree", "project"],
    ],
    [
      "migrate, a satellite that owns its database",
      (r) => migrateCommand(fixture("satellite", owned).cliRoot, { databaseUrl: PRODUCTION_DIRECT }, r),
      ["tree", "project"],
    ],
  ];
  for (const [name, run, stopsAt] of cases) {
    const { runner, calls } = recordingRunner({ ...kitAliases, envProblems: 3 });
    await assert.rejects(run(runner), refused, name);
    assert.deepEqual(calls, stopsAt, `${name}: nothing synced, linked, pulled, built or promoted`);
  }

  // A dry run reads and reports it, and refuses nothing, as for F-49.
  const dry = recordingRunner(kitAliases);
  const shown = await captureOutput(() => deploy(fixture("satellite").cliRoot, { dryRun: true }, dry.runner));
  assert.equal(shown.error, undefined, shown.out);
  assert.match(
    shown.out,
    /\[dry-run\] a real run would refuse: this satellite config points at sat \(prj_sat\) serves demo\.example\.com/,
  );

  // The kit on its own project, and a satellite on its own, deploy as before.
  const kit = recordingRunner(kitAliases);
  await deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, kit.runner);
  assert.deepEqual(kit.calls, KIT_ORDER);
  const own = recordingRunner({ aliases: ["app1.example.net"] });
  await up(fixture("satellite").cliRoot, {}, own.runner);
  assert.deepEqual(
    own.calls,
    UP_ORDER.filter((s) => s !== "migrate"),
  );
});

test("F-50: doctor counts a satellite config on the issuer's project", async () => {
  const { cliRoot } = fixture("satellite");
  const run = async (aliases: string[]) => {
    fakeProjects({ prj_sat: { name: "sat", aliases } });
    try {
      const report = await captureOutput(() => doctor(cliRoot));
      assert.equal(report.error, undefined, report.out);
      return { problems: report.result as number, out: report.out };
    } finally {
      globalThis.fetch = offline;
    }
  };
  // The fixture has no Vercel CLI and no app checkout, so the count is never
  // zero: what matters is what the project adds to it.
  const own = await run(["app1.example.net"]);
  assert.match(own.out, /vercel project\s+ok sat does not serve the issuer's host/);
  const kits = await run(["demo.example.com"]);
  assert.equal(kits.problems, own.problems + 1, kits.out);
  assert.match(
    kits.out,
    /vercel project\s+wrong — this satellite config points at sat \(prj_sat\) serves demo\.example\.com/,
  );
  assert.match(kits.out, new RegExp(`config file\\s+${literal(join(cliRoot, ".drk-deploy.json"))}`));
});

test("F-50: --config and DRK_DEPLOY_CONFIG pick the deployment's file; the flag wins, and an empty flag is refused", async () => {
  // A relative name is a file beside the CLI, where the default file is and
  // where vercel-cli/.gitignore ignores it, never one in the working
  // directory: the .cmd wrapper runs from wherever the operator stands, and
  // from the kit's root the file used to land in the kit's tree, unignored.
  const cliRoot = join(workspace, "config-cli-root");
  const beside = (file: string) => join(cliRoot, file);
  assert.notEqual(beside("a.json"), join(process.cwd(), "a.json"), "the test tells the two apart");
  const cases: [string, string | undefined, Record<string, string>, string | null][] = [
    ["neither", undefined, {}, null],
    ["the flag", "a.json", {}, beside("a.json")],
    ["the variable", undefined, { DRK_DEPLOY_CONFIG: "b.json" }, beside("b.json")],
    ["both: the flag wins", "a.json", { DRK_DEPLOY_CONFIG: "b.json" }, beside("a.json")],
    ["an empty variable is unset", undefined, { DRK_DEPLOY_CONFIG: "  " }, null],
    ["an absolute path", join(workspace, "c.json"), {}, join(workspace, "c.json")],
    [
      "an absolute path in the variable",
      undefined,
      { DRK_DEPLOY_CONFIG: join(workspace, "d.json") },
      join(workspace, "d.json"),
    ],
  ];
  for (const [name, flag, env, expected] of cases) {
    assert.equal(configFileFrom(flag, env, cliRoot), expected, name);
  }
  assert.throws(
    () => configFileFrom(" ", { DRK_DEPLOY_CONFIG: "b.json" }, cliRoot),
    refusal(/^--config was given an EMPTY value\.$/),
    "an explicit empty flag is never skipped over",
  );

  // A file per deployment: init writes the named one, every command reads
  // it, and the default file is left alone.
  fakeProjects(FLEET);
  const fleet = fleetRoot();
  const standaloneFile = join(fleet.cliRoot, ".drk-deploy.app-standalone.json");
  const handoffFile = join(fleet.cliRoot, ".drk-deploy.app-handoff.json");
  try {
    await init(fleet.cliRoot, {
      project: "prj_kit",
      domain: "demo.example.com",
      kitRoot: fleet.kitRoot,
      yes: true,
    });
    const kitDefault = configText(fleet.cliRoot);
    useConfigFile(standaloneFile);
    await initStandalone(fleet);
    useConfigFile(handoffFile);
    // A first init in its own file: nothing to inherit, nothing to refuse.
    await init(fleet.cliRoot, {
      project: "prj_handoff",
      domain: "app2.example.net",
      satellite: "handoff",
      appRoot: fleet.handoff,
      issuer: ISSUER,
      kitRoot: fleet.kitRoot,
      yes: true,
    });
    assert.equal(configPath(fleet.cliRoot), handoffFile);
    assert.equal(requireConfig(fleet.cliRoot).projectId, "prj_handoff");
    useConfigFile(standaloneFile);
    assert.equal(requireConfig(fleet.cliRoot).projectId, "prj_standalone");
    useConfigFile(null);
    assert.equal(configText(fleet.cliRoot), kitDefault, "the kit's default file is untouched");
    assert.equal(requireConfig(fleet.cliRoot).projectId, "prj_kit");

    useConfigFile(join(fleet.cliRoot, "missing.json"));
    assert.throws(
      () => requireConfig(fleet.cliRoot),
      refusal(/there is no .+missing\.json\.$/, /drk-deploy --config ".+missing\.json" init/),
    );
  } finally {
    useConfigFile(null);
    globalThis.fetch = offline;
  }
});

test("F-50: the CLI entry point hands --config (before or after the command) and DRK_DEPLOY_CONFIG to every command", () => {
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const dir = join(workspace, `config-${++fixtures}`);
  mkdirSync(join(dir, "home"), { recursive: true });
  // Unparseable, so the command stops at reading the file and names the one it read.
  for (const name of ["flag.json", "variable.json"]) writeFileSync(join(dir, name), "{ not json");
  const cli = (args: string[], extra: Record<string, string> = {}) => {
    // No token, no saved credential (the profile is a scratch folder) and no
    // inherited DRK_DEPLOY_CONFIG: were the file not honoured, the run would
    // stop at the missing token before reaching anything.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !["VERCEL_TOKEN", "DRK_DEPLOY_CONFIG"].includes(key.toUpperCase()),
      ),
    );
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, HOME: join(dir, "home"), USERPROFILE: join(dir, "home"), NO_COLOR: "1", ...extra },
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const read = (file: string) => new RegExp(`${literal(join(dir, file))} is not valid JSON`);
  const [flagFile, variableFile] = [join(dir, "flag.json"), join(dir, "variable.json")];

  for (const args of [
    ["--config", flagFile, "env:check"],
    ["env:check", "--config", flagFile],
  ]) {
    const flag = cli(args, { DRK_DEPLOY_CONFIG: variableFile });
    assert.equal(flag.status, 1, flag.out);
    assert.match(flag.out, read("flag.json"), args.join(" "));
  }
  const variable = cli(["env:check"], { DRK_DEPLOY_CONFIG: variableFile });
  assert.match(variable.out, read("variable.json"));
  const missing = cli(["status"], { DRK_DEPLOY_CONFIG: join(dir, "nowhere.json") });
  assert.match(missing.out, new RegExp(`there is no ${literal(join(dir, "nowhere.json"))}`));

  // A relative name is read beside the CLI, as the default file is, and not
  // from the working directory the wrapper was run in. Nothing is created:
  // `status` stops at the missing file.
  const cliDir = join(dirname(entry), "..");
  const unique = `.drk-deploy.entry-test-${process.pid}-${fixtures}.json`;
  for (const [how, args, extra] of [
    ["--config", ["--config", unique, "status"], {}],
    ["DRK_DEPLOY_CONFIG", ["status"], { DRK_DEPLOY_CONFIG: unique }],
  ] as const) {
    const relative = cli([...args], extra);
    assert.equal(relative.status, 1, relative.out);
    assert.match(relative.out, new RegExp(`there is no ${literal(join(cliDir, unique))}\\.`), how);
    assert.doesNotMatch(relative.out, new RegExp(literal(join(dir, unique))), how);
  }
  assert.equal(existsSync(join(cliDir, unique)), false);
  const empty = cli(["--config", "", "doctor"]);
  assert.equal(empty.status, 1, empty.out);
  assert.match(empty.out, /--config was given an EMPTY value/);
});

test("F-50: under --config, the commands the refusals print name that file, so they act on the same deployment", async () => {
  fakeProjects(FLEET);
  const fleet = fleetRoot();
  const file = join(fleet.cliRoot, ".drk-deploy.app-standalone.json");
  const named = (command: string) => new RegExp(literal(`drk-deploy --config "${file}" ${command}`));
  try {
    // The layout the README recommends: the kit keeps the default file, and
    // the satellite has its own.
    await init(fleet.cliRoot, {
      project: "prj_kit",
      domain: "demo.example.com",
      kitRoot: fleet.kitRoot,
      yes: true,
    });
    const kitDefault = configText(fleet.cliRoot);
    useConfigFile(file);
    await initStandalone(fleet);

    // The issuer refusal's fix. Printed bare, it ran on the KIT's default
    // file: a kit config names no satellite, so it counted as a re-run, and
    // init saved the kit's config on the satellite's project.
    await assert.rejects(
      init(fleet.cliRoot, { project: "prj_kit", domain: "app1.example.net", yes: true }),
      issuersProject(named("init --project <its project> --domain <its host> --application-id <its id>")),
    );
    // The same refusal from deploy's gate, and the preflight's own hint.
    const gate = recordingRunner({ aliases: ["demo.example.com"] });
    await assert.rejects(
      // app-standalone owns its database; the migration is not what is shown here.
      deploy(fleet.cliRoot, { skipChecks: true, skipMigrations: true }, gate.runner),
      refusal(/SSO issuer's own Vercel project/, named("init --project <its project>"), 2),
    );
    assert.deepEqual(gate.calls, CHECKS);
    const preflight = recordingRunner({ envProblems: 2 });
    await assert.rejects(
      deploy(fleet.cliRoot, { skipMigrations: true }, preflight.runner),
      refusal(/^2 environment problem\(s\)\.$/, named("env:sync")),
    );
    // A broken file is named, and so is the file the repair is run on.
    assert.throws(
      () => resolveProfile({ target: "satellite" }),
      refusal(
        new RegExp(`^${literal(file)} sets \`target: "satellite"\` but has no \`satellite\` block\\.$`),
        named("init --satellite <standalone|handoff|shared>"),
      ),
    );

    useConfigFile(null);
    assert.equal(configText(fleet.cliRoot), kitDefault, "the kit's file is untouched");
    // With the default file the commands stay as they always were.
    assert.throws(
      () => resolveProfile({ target: "satellite" }),
      refusal(
        /^\.drk-deploy\.json sets `target: "satellite"` but has no `satellite` block\.$/,
        /^Re-run `drk-deploy init --satellite <standalone\|handoff\|shared>`/,
      ),
    );
  } finally {
    useConfigFile(null);
    globalThis.fetch = offline;
  }
});

test("F-50: a moved checkout is re-recorded by the init deploy prints, and keeps the product name", async () => {
  fakeProjects(FLEET);
  try {
    const fleet = fleetRoot();
    await initStandalone(fleet);
    const recorded = configOf(fleet.cliRoot);
    // Nothing is offered while the recorded checkout still exists: another
    // folder is then another app far more often than a move.
    await assert.rejects(
      init(fleet.cliRoot, { appRoot: fleet.handoff, yes: true }),
      (err: unknown) =>
        err instanceof CliError &&
        /records another deployment/.test(err.message) &&
        !/--project prj_standalone/.test(err.hint ?? ""),
    );
    // The checkout moves, as after a re-clone of the satellites' repository.
    const moved = satelliteCheckout(join(fleet.cliRoot, "re-cloned", "app-standalone"), "app-standalone");
    rmSync(fleet.standalone, { recursive: true, force: true });

    // deploy's fix used to be `init --app-root <path>`, which F-50 refuses as
    // another deployment. It now names this one in full, from the file.
    const printed =
      "drk-deploy init --project prj_standalone --domain app1.example.net --application-id standalone --satellite standalone --app-root <path-to-the-satellite-checkout> --own-database";
    const { runner, calls } = recordingRunner();
    await assert.rejects(
      deploy(fleet.cliRoot, {}, runner),
      refusal(/^The checkout to deploy does not exist: /, new RegExp(`^Re-run \`${literal(printed)}\``)),
    );
    assert.deepEqual(calls, [], "stopped before any step");

    // A bare new --app-root is still another deployment. Its refusal offers
    // the same command, with the path filled in, because the recorded
    // checkout is gone.
    const filled = printed.replace("<path-to-the-satellite-checkout>", `"${moved}"`);
    await assert.rejects(
      init(fleet.cliRoot, { appRoot: moved, yes: true }),
      refusal(/records another deployment: its app checkout is /, new RegExp(literal(filled))),
    );
    assert.deepEqual(configOf(fleet.cliRoot), recorded, "refusals write nothing");

    // Run as printed, it is the same deployment in its new place. Its product
    // name is kept: --project names the recorded project.
    await init(fleet.cliRoot, {
      project: "prj_standalone",
      domain: "app1.example.net",
      applicationId: "standalone",
      satellite: "standalone",
      appRoot: moved,
      ownDatabase: true,
      yes: true,
    });
    assert.deepEqual(configOf(fleet.cliRoot), {
      ...recorded,
      satellite: { ...recorded.satellite, appRoot: moved },
    });
    assert.equal(configOf(fleet.cliRoot).appName, "Standalone");

    // A satellite block with no checkout recorded at all (resolveProfile's
    // hint) is filled in, not changed: there is no other checkout to carry
    // the deployment away from.
    const blank = fleetRoot();
    await initStandalone(blank);
    const complete = configOf(blank.cliRoot);
    const { appRoot: _dropped, ...rest } = complete.satellite;
    writeFileSync(join(blank.cliRoot, ".drk-deploy.json"), JSON.stringify({ ...complete, satellite: rest }));
    assert.throws(
      () => resolveProfile(configOf(blank.cliRoot)),
      refusal(/has no `appRoot`/, /^Re-run `drk-deploy init --app-root <path-to-the-satellite-checkout>`\.$/),
    );
    await init(blank.cliRoot, { appRoot: blank.standalone, yes: true });
    assert.deepEqual(configOf(blank.cliRoot), complete);
  } finally {
    globalThis.fetch = offline;
  }
});

test("F-50: a new deployment keeps only the fleet's issuer of the recorded satellite block", async () => {
  // The narrowing that keeps a database mode, a checkout or a cookie domain
  // from being inherited where nobody is asked: init under --yes, and the
  // interactive database question, which is put only when nothing is
  // recorded.
  const block = {
    option: "shared",
    appRoot: join(workspace, "app-shared"),
    issuerOrigin: ISSUER,
    database: "own",
    cookieDomain: ".example.com",
  };
  const satellite = {
    projectId: "prj_standalone",
    origin: "https://app1.example.net",
    target: "satellite",
    satellite: block,
  };
  const cases: [string, unknown, boolean, unknown][] = [
    ["a re-run of the same deployment keeps the whole block", satellite, false, block],
    ["a new deployment keeps the issuer only", satellite, true, { issuerOrigin: ISSUER }],
    [
      "a new deployment of a block with no issuer keeps nothing",
      { ...satellite, satellite: { ...block, issuerOrigin: undefined } },
      true,
      undefined,
    ],
    ["a kit config has no block", { projectId: "prj_kit", origin: ISSUER }, false, undefined],
    ["a kit config turned into a satellite", { projectId: "prj_kit", origin: ISSUER }, true, undefined],
    ["no config", null, false, undefined],
  ];
  for (const [name, existing, isNew, expected] of cases) {
    assert.deepEqual(recordedSatelliteAnswers(existing as never, isNew), expected, name);
  }

  // And end to end: an Option C deployment named in full under --yes, over
  // another Option C app's file, is not handed that app's cookie domain.
  fakeProjects({
    ...FLEET,
    prj_shared: { name: "app-shared", aliases: ["app3.example.com"] },
    prj_shared_2: { name: "app-shared-2", aliases: ["app4.example.com"] },
  });
  try {
    const fleet = fleetRoot();
    const shared = satelliteCheckout(join(fleet.cliRoot, "app-shared"), "app-shared");
    const other = satelliteCheckout(join(fleet.cliRoot, "app-shared-2"), "app-shared-2");
    await init(fleet.cliRoot, {
      project: "prj_shared",
      domain: "app3.example.com",
      satellite: "shared",
      appRoot: shared,
      issuer: ISSUER,
      kitRoot: fleet.kitRoot,
      cookieDomain: ".example.com",
      yes: true,
    });
    assert.equal(configOf(fleet.cliRoot).satellite.cookieDomain, ".example.com");
    const recorded = configText(fleet.cliRoot);
    await assert.rejects(
      init(fleet.cliRoot, {
        project: "prj_shared_2",
        domain: "app4.example.com",
        applicationId: "shared-2",
        satellite: "shared",
        appRoot: other,
        yes: true,
      }),
      refusal(/^An Option C satellite needs a cookie domain\.$/),
    );
    assert.equal(configText(fleet.cliRoot), recorded);
  } finally {
    globalThis.fetch = offline;
  }
});

/* ================================================================== */
/*  F-51: an unhealthy probe is rolled back, or the rollback is named  */
/* ================================================================== */

/** The command that promotes {@link PREVIOUS} back, for the fixture's team config. */
const ROLLBACK_COMMAND = "vercel promote dpl_previous123 --scope=team_test";
/** {@link PREVIOUS} as the operator reads it. */
const PREVIOUS_SHOWN = "https://kit-previous123.vercel.app (dpl_previous123)";
/** A kit production whose variables set the SSO signing key, stored sensitive as `vercel pull` shows it. */
const SIGNING_PRODUCTION = { DATABASE_URL: PRODUCTION_POOLED, SSO_HANDOFF_PRIVATE_KEY: "[SENSITIVE]" };

test("F-51: the deployment production serves is read before anything writes, and printed", async () => {
  // deploy: after the checks, before anything is linked, pulled, migrated or promoted.
  const kit = recordingRunner();
  const shown = await captureOutput(() =>
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, kit.runner),
  );
  assert.equal(shown.error, undefined, shown.out);
  assert.deepEqual(kit.calls, KIT_ORDER);
  assert.ok(kit.calls.indexOf("serving") < kit.calls.indexOf("link"), "read before anything writes");
  assert.match(shown.out, new RegExp(`Rollback target[\\s\\S]*serving now\\s+${literal(PREVIOUS_SHOWN)}`));
  assert.match(
    shown.out,
    /if the probe fails\s+the new build stays live, and the command that promotes this one back is printed \(pass --rollback-on-fail \(or --yes\) to have it run\)/,
  );
  // With the deploy's own invocation: the recorded project, and the token in the environment.
  const [invocation] = kit.args.serving as [{ config: { projectId: string }; env: Record<string, string> }];
  assert.equal(invocation.config.projectId, "prj_test");
  assert.equal(invocation.env.VERCEL_TOKEN, TOKEN);

  // up: before env:sync writes anything.
  const upped = recordingRunner();
  await up(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, upped.runner);
  assert.deepEqual(upped.calls, UP_ORDER);
  assert.ok(upped.calls.indexOf("serving") < upped.calls.indexOf("envSync"), "read before env:sync");

  // A production that serves nothing yet has nothing to roll back to, and deploys.
  const first = recordingRunner({ serving: null });
  const firstShown = await captureOutput(() =>
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, first.runner),
  );
  assert.equal(firstShown.error, undefined, firstShown.out);
  assert.deepEqual(first.calls, KIT_ORDER);
  assert.match(firstShown.out, /serving now\s+nothing yet: there is no deployment to roll back to/);

  // One that cannot be read stops a real run, rollback or not, before anything writes.
  for (const [name, run, flags] of [
    ["deploy", deploy, {}],
    ["deploy --yes", deploy, { yes: true }],
    ["up --no-rollback-on-fail", up, { rollbackOnFail: false }],
  ] as const) {
    const real = recordingRunner({ failAt: "serving" });
    await assert.rejects(
      run(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, ...flags }, real.runner),
      /^Error: serving failed$/,
      name,
    );
    assert.equal(real.calls.at(-1), "serving", `${name}: nothing synced, linked, pulled or migrated`);
  }
  // A dry run says so and plans on.
  const dry = recordingRunner({ failAt: "serving" });
  const unread = await captureOutput(() =>
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, dryRun: true }, dry.runner),
  );
  assert.equal(unread.error, undefined, unread.out);
  assert.match(
    unread.out,
    /\[dry-run\] could not read which deployment https:\/\/demo\.example\.com serves \(serving failed\)/,
  );
  // And a dry run that reads it shows what an unhealthy probe would do.
  for (const [flags, verb] of [
    [{ rollbackOnFail: true }, "run"],
    [{}, "print"],
  ] as const) {
    const plan = recordingRunner();
    const planned = await captureOutput(() =>
      deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, dryRun: true, ...flags }, plan.runner),
    );
    assert.equal(planned.error, undefined, planned.out);
    assert.match(
      planned.out,
      new RegExp(`\\[dry-run\\] on an unhealthy probe it would ${verb}: ${literal(ROLLBACK_COMMAND)}`),
    );
    assert.equal(plan.calls.includes("rollback"), false);
  }
});

test("F-51: an unhealthy probe with no rollback exits 3, leaves the build live, and prints the exact rollback command", async () => {
  // The printed command is the only way back. A re-run with
  // --rollback-on-fail would record this build as the one serving and promote
  // it again, so the hint names the flag only for later releases.
  const onlyTheCommand =
    "\\. Re-running with --rollback-on-fail would not do it: a new run records this build as the one to roll back to\\. Pass --rollback-on-fail on later releases to have the rollback done for you\\.";
  const stillServing = new RegExp(
    `^It is still serving\\. To put back the deployment production served before this run, ${literal(PREVIOUS_SHOWN)}, run \`${literal(ROLLBACK_COMMAND)}\`${onlyTheCommand} Leave the migrations applied: they are forward-only, and that deployment served against them until the promotion\\.$`,
  );
  for (const [name, flags] of [
    ["no flag", {}],
    ["--no-rollback-on-fail, even under --yes", { yes: true, rollbackOnFail: false }],
  ] as const) {
    const { runner, calls } = recordingRunner({ verdicts: [UNHEALTHY] });
    await assert.rejects(
      deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, ...flags }, runner),
      refusal(
        /^The deployment is live but not healthy: its health probes fail \(see above\)\.$/,
        stillServing,
        3,
      ),
      name,
    );
    assert.deepEqual(calls, KIT_ORDER, `${name}: nothing is rolled back`);
  }

  // The command names the project's owner as the Vercel CLI's scope, or none
  // when no owner is recorded. A run with no migrate step says nothing of migrations.
  const cases: [string, string, Record<string, unknown>, RegExp][] = [
    [
      "a personal account",
      fixture("kit", { owner: "personal" }).cliRoot,
      { databaseUrl: PRODUCTION_DIRECT },
      new RegExp(
        `run \`vercel promote dpl_previous123 --scope=Xq7personalAccount42\`${onlyTheCommand} Leave`,
      ),
    ],
    [
      "no owner recorded",
      fixture("kit", { owner: "unrecorded" }).cliRoot,
      { databaseUrl: PRODUCTION_DIRECT },
      new RegExp(`run \`vercel promote dpl_previous123\`${onlyTheCommand} Leave`),
    ],
    [
      "a satellite on the kit's database",
      fixture("satellite").cliRoot,
      {},
      new RegExp(`run \`vercel promote dpl_previous123 --scope=team_test\`${onlyTheCommand}$`),
    ],
  ];
  for (const [name, cliRoot, options, hint] of cases) {
    const { runner, calls } = recordingRunner({ verdicts: [UNHEALTHY] });
    await assert.rejects(deploy(cliRoot, options, runner), refusal(/live but not healthy/, hint, 3), name);
    assert.equal(calls.includes("rollback"), false, name);
  }
  const satellite = recordingRunner({ verdicts: [UNHEALTHY] });
  await assert.rejects(
    deploy(fixture("satellite").cliRoot, {}, satellite.runner),
    refusal(/^The satellite is live but not healthy: /),
  );
});

test("F-51: --rollback-on-fail (on by default under --yes) promotes the recorded deployment back, probes again, and exits 4", async () => {
  const rolledBack = refusal(
    new RegExp(
      `^The new build failed its probe \\(its health probes fail \\(see above\\)\\) and was rolled back: ${literal(PREVIOUS_SHOWN)} serves production again and passes the probe\\.$`,
    ),
    /^The release failed and is no longer live\. Fix it and deploy again\. Leave the migrations applied: they are forward-only, and that deployment served against them until the promotion\.$/,
    4,
  );
  type Run = (cliRoot: string, runner: never) => Promise<void>;
  const cases: [string, Run, string[]][] = [
    [
      "deploy --rollback-on-fail",
      (cliRoot, r) => deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, rollbackOnFail: true }, r),
      KIT_ORDER,
    ],
    [
      "deploy --yes",
      (cliRoot, r) => deploy(cliRoot, { databaseUrl: PRODUCTION_DIRECT, yes: true }, r),
      KIT_ORDER,
    ],
    ["up --yes", (cliRoot, r) => up(cliRoot, { databaseUrl: PRODUCTION_DIRECT, yes: true }, r), UP_ORDER],
  ];
  for (const [name, run, order] of cases) {
    const { cliRoot, kitRoot } = fixture("kit");
    const fake = recordingRunner({ verdicts: [UNHEALTHY], production: SIGNING_PRODUCTION });
    const shown = await captureOutput(() => run(cliRoot, fake.runner));
    assert.ok(rolledBack(shown.error), `${name}: ${String(shown.error)}`);
    assert.deepEqual(fake.calls, [...order, "rollback", "verify"], name);
    // The deployment recorded before the promotion, through the run's own invocation.
    const [invocation, to] = fake.args.rollback as [{ root: string; env: Record<string, string> }, unknown];
    assert.deepEqual(to, PREVIOUS, name);
    assert.equal(invocation.root, kitRoot, name);
    assert.equal(invocation.env.VERCEL_TOKEN, TOKEN, name);
    // The first probe holds the kit to production's signing key. The second,
    // of a deployment built before this run's variables, does not.
    assert.deepEqual(
      fake.every.verify!.map((received) => received[2]),
      [{ handoffSigning: true }, { handoffSigning: null }],
      name,
    );
    assert.match(
      shown.out,
      new RegExp(`Rollback[\\s\\S]*Promoting ${literal(PREVIOUS_SHOWN)} back to production`),
      name,
    );
  }

  // A satellite is rolled back the same way, and its hint says nothing of migrations.
  const satellite = recordingRunner({ verdicts: [UNHEALTHY] });
  const satelliteShown = await captureOutput(() =>
    deploy(fixture("satellite").cliRoot, { rollbackOnFail: true }, satellite.runner),
  );
  assert.ok(
    refusal(
      /^The new build failed its probe \(.*\) and was rolled back: /,
      /^The release failed and is no longer live\. Fix it and deploy again\.$/,
      4,
    )(satelliteShown.error),
    String(satelliteShown.error),
  );
  assert.match(satelliteShown.out, /Rollback[\s\S]*The satellite is live but not healthy: /);
  assert.deepEqual(satellite.calls.slice(-3), ["verify", "rollback", "verify"]);
});

test("F-51: a rollback that fails, or restores a deployment that fails too, exits 5, and nothing runs after a failed rollback", async () => {
  const failed = recordingRunner({ verdicts: [UNHEALTHY], failAt: "rollback" });
  await assert.rejects(
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, rollbackOnFail: true }, failed.runner),
    refusal(
      /The rollback failed as well \(rollback failed\), so the unhealthy build is still live\.$/,
      new RegExp(`^Run it by hand: \`${literal(ROLLBACK_COMMAND)}\`, or promote ${literal(PREVIOUS_SHOWN)}`),
      5,
    ),
  );
  assert.deepEqual(failed.calls, [...KIT_ORDER, "rollback"], "no second probe after a failed rollback");

  const still = recordingRunner({
    verdicts: [UNHEALTHY, { healthy: false, problems: ["its health probes fail (see above)"] }],
  });
  await assert.rejects(
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, yes: true }, still.runner),
    refusal(
      new RegExp(
        `^The new build failed its probe \\(its health probes fail \\(see above\\)\\) and was rolled back to ${literal(PREVIOUS_SHOWN)}, which fails the probe too: its health probes fail \\(see above\\)\\.$`,
      ),
      /what fails is not only the new build/,
      5,
    ),
  );
  assert.deepEqual(still.calls, [...KIT_ORDER, "rollback", "verify"]);
});

test("F-51: nothing recorded means nothing to roll back to (exit 3), and a healthy probe ends the run as before", async () => {
  const none = recordingRunner({ serving: null, verdicts: [UNHEALTHY] });
  await assert.rejects(
    deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, rollbackOnFail: true }, none.runner),
    refusal(/^The deployment is live but not healthy/, /there is nothing to roll back to/, 3),
  );
  assert.deepEqual(none.calls, KIT_ORDER);

  for (const flags of [{}, { rollbackOnFail: true }, { yes: true }, { rollbackOnFail: false }]) {
    const healthy = recordingRunner();
    await deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, ...flags }, healthy.runner);
    assert.deepEqual(healthy.calls, KIT_ORDER, JSON.stringify(flags));
    const satellite = recordingRunner();
    await up(fixture("satellite").cliRoot, flags, satellite.runner);
    assert.deepEqual(
      satellite.calls,
      UP_ORDER.filter((s) => s !== "migrate"),
      JSON.stringify(flags),
    );
  }
});

test("F-51: --rollback-on-fail, --no-rollback-on-fail and --yes parse into the options rollbackPolicy reads, on deploy and up", async () => {
  // Parsed as `deploy` and `up` declare them. Neither rollback flag given
  // leaves `rollbackOnFail` undefined, so `--yes` decides. Were only
  // `--no-rollback-on-fail` declared, commander would default it to true and
  // every run would roll back.
  const parse = (args: string[]) => {
    const command = withRollbackOptions(new Command("deploy").exitOverride(), "the command's own help");
    command.parse(args, { from: "user" });
    return command.opts();
  };
  const cases: [string[], Record<string, boolean>, number][] = [
    [[], {}, 3],
    [["-y"], { yes: true }, 4],
    [["-y", "--no-rollback-on-fail"], { yes: true, rollbackOnFail: false }, 3],
    [["--no-rollback-on-fail", "--yes"], { yes: true, rollbackOnFail: false }, 3],
    [["--rollback-on-fail"], { rollbackOnFail: true }, 4],
    [["--no-rollback-on-fail"], { rollbackOnFail: false }, 3],
  ];
  for (const [args, parsed, exitCode] of cases) {
    const name = args.join(" ") || "no flag";
    const options = parse(args);
    assert.deepEqual(options, parsed, name);
    // And the release does with them what the flags say: 3 leaves the build
    // live, 4 rolled it back.
    const fake = recordingRunner({ verdicts: [UNHEALTHY] });
    await assert.rejects(
      deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT, ...options }, fake.runner),
      refusal(/./, /./, exitCode),
      name,
    );
    assert.equal(fake.calls.includes("rollback"), exitCode === 4, name);
  }

  // The built entry point declares all three on both commands that promote.
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  for (const command of ["deploy", "up"]) {
    const help = spawnSync(process.execPath, [entry, command, "--help"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(help.status, 0, `${help.stdout}${help.stderr}`);
    for (const flag of ["--rollback-on-fail", "--no-rollback-on-fail", "-y, --yes"]) {
      assert.match(help.stdout, new RegExp(`^\\s+${literal(flag)}\\s`, "m"), `${command} ${flag}`);
    }
  }
});

test("F-51: the kit's probe is told whether production sets SSO_HANDOFF_PRIVATE_KEY, from the pulled variables; a satellite's is not", async () => {
  const cases: [
    string,
    "kit" | "satellite",
    Record<string, unknown>,
    Record<string, string> | null,
    boolean | null,
  ][] = [
    ["the key, stored sensitive", "kit", { databaseUrl: PRODUCTION_DIRECT }, SIGNING_PRODUCTION, true],
    ["no key", "kit", { databaseUrl: PRODUCTION_DIRECT }, { DATABASE_URL: PRODUCTION_POOLED }, false],
    [
      "an empty key",
      "kit",
      { databaseUrl: PRODUCTION_DIRECT },
      { DATABASE_URL: PRODUCTION_POOLED, SSO_HANDOFF_PRIVATE_KEY: "" },
      false,
    ],
    ["no file pulled", "kit", { skipMigrations: true }, null, null],
    ["a satellite", "satellite", {}, { SSO_HANDOFF_PRIVATE_KEY: "[SENSITIVE]" }, null],
  ];
  for (const [name, target, options, production, handoffSigning] of cases) {
    const fake = recordingRunner({ production });
    await deploy(fixture(target).cliRoot, options, fake.runner);
    assert.deepEqual((fake.args.verify as unknown[])[2], { handoffSigning }, name);
  }
});

test("F-51: the real rollback step runs `vercel promote <id> --scope=<owner>` in the checkout, never --yes, and is the printed command", async () => {
  const { cliRoot, kitRoot } = fixture("kit");
  const record = join(cliRoot, "promote.json");
  const stub = join(cliRoot, "record-vercel.cjs");
  writeFileSync(
    stub,
    `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.VERCEL_TOKEN ?? null, cwd: process.cwd() }));\n`,
  );
  const invocation = {
    vercelJs: stub,
    config: requireConfig(cliRoot),
    root: kitRoot,
    env: { VERCEL_TOKEN: TOKEN },
    orgId: "team_test",
  };
  await releaseRunner.rollback(invocation as never, PREVIOUS);
  const ran = JSON.parse(readFileSync(record, "utf8"));
  assert.deepEqual(ran.argv, ["promote", "dpl_previous123", "--scope=team_test"]);
  assert.equal(`vercel ${ran.argv.join(" ")}`, ROLLBACK_COMMAND, "the printed command is the one that runs");
  assert.equal(ran.token, TOKEN, "the token travels in the environment");
  assert.equal(String(ran.cwd).toLowerCase(), kitRoot.toLowerCase(), "in the deployed checkout");

  await releaseRunner.rollback({ ...invocation, orgId: null } as never, PREVIOUS);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")).argv, ["promote", "dpl_previous123"]);

  writeFileSync(stub, "process.exit(1);\n");
  await assert.rejects(
    releaseRunner.rollback(invocation as never, PREVIOUS),
    refusal(/^vercel promote failed — the unhealthy build is still live \(exit 1\)$/, /^$/),
  );
});

test("F-51: the real serving step asks which deployment the origin's host is aliased to, in the recorded project", async () => {
  const config = requireConfig(fixture("kit").cliRoot);
  const requests: string[] = [];
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(`${url.hostname}${url.pathname}${url.search}`);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  };
  try {
    answer(200, {
      alias: "demo.example.com",
      created: "2026-09-01T00:00:00.000Z",
      uid: "alias_1",
      projectId: "prj_test",
      deploymentId: "dpl_live",
      deployment: { id: "dpl_live", url: "kit-live.vercel.app" },
    });
    assert.deepEqual(await releaseRunner.serving({ config } as never), {
      id: "dpl_live",
      url: "kit-live.vercel.app",
    });
    assert.equal(requests.length, 1);
    const [path, search] = requests[0]!.split("?");
    assert.equal(path, "api.vercel.com/v4/aliases/demo.example.com");
    const query = new URLSearchParams(search);
    assert.equal(query.get("projectId"), "prj_test", "only an alias of the recorded project");
    assert.equal(query.get("teamId"), "team_test");

    answer(404, { error: { code: "not_found", message: "The alias was not found" } });
    assert.equal(
      await releaseRunner.serving({ config } as never),
      null,
      "no alias yet: nothing to roll back to",
    );

    answer(403, { error: { code: "forbidden", message: "Not authorized" } });
    await assert.rejects(
      releaseRunner.serving({ config } as never),
      refusal(/^Could not read which deployment demo\.example\.com serves/),
    );
  } finally {
    globalThis.fetch = offline;
  }
});

/** Answers the probes by host and path, as a deployment would; anything else is a 404. */
function fakeProbes(routes: Record<string, { status: number; body?: unknown }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = routes[`${url.host}${url.pathname}`];
    if (!route) return new Response("", { status: 404 });
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), { status: route.status });
  }) as typeof fetch;
}

/** The kit's probes answering as a healthy kit, and its JWKS publishing `keys` (unset: not served). */
function kitAnswers(keys?: unknown[], signIn = 401): Record<string, { status: number; body?: unknown }> {
  return {
    "demo.example.com/api/health": { status: 200 },
    "demo.example.com/api/health/ready": { status: 200 },
    "demo.example.com/api/auth/sign-in/email": { status: signIn },
    ...(keys ? { "demo.example.com/api/sso/jwks.json": { status: 200, body: { keys } } } : {}),
  };
}

/** A satellite's probes answering as a healthy consumer, its JWKS `own`, and the issuer's `issuer`. */
function satelliteAnswers(
  own: unknown[],
  issuer?: unknown[],
): Record<string, { status: number; body?: unknown }> {
  return {
    "app1.example.net/api/health": { status: 200 },
    "app1.example.net/api/health/ready": { status: 200 },
    "app1.example.net/api/sso/consume": { status: 401 },
    "app1.example.net/api/sso/jwks.json": { status: 200, body: { keys: own } },
    ...(issuer ? { "demo.example.com/api/sso/jwks.json": { status: 200, body: { keys: issuer } } } : {}),
  };
}

const KIT_KEY = { kty: "OKP", crv: "Ed25519", kid: "kit-kid", x: "KIT-PUBLIC-X" };

test("F-51: the kit's probe fails on an empty or unserved key set only when production sets a signing key", async () => {
  const config = requireConfig(fixture("kit").cliRoot);
  const profile = resolveProfile(config);
  const cases: [
    string,
    Record<string, { status: number; body?: unknown }>,
    boolean | null,
    string[],
    RegExp,
  ][] = [
    [
      "signing, empty key set",
      kitAnswers([]),
      true,
      ["it publishes an EMPTY SSO key set although production sets SSO_HANDOFF_PRIVATE_KEY"],
      /every handoff fails/,
    ],
    [
      "signing, no key set served",
      kitAnswers(),
      true,
      ["it does not serve /api/sso/jwks.json although production sets SSO_HANDOFF_PRIVATE_KEY"],
      /every handoff fails/,
    ],
    [
      "no SSO: an empty key set is right",
      kitAnswers([]),
      false,
      [],
      /EMPTY key set[\s\S]*Production sets no SSO_HANDOFF_PRIVATE_KEY, which is right only if this deployment issues no handoffs/,
    ],
    ["unknown: a warning", kitAnswers([]), null, [], /whether it should sign handoffs is unknown/],
    ["signing, publishing", kitAnswers([KIT_KEY]), true, [], /SSO JWKS publishes 1 key\(s\)/],
    [
      "a failed sign-in, keys published",
      kitAnswers([KIT_KEY], 500),
      true,
      ["its health probes fail (see above)"],
      /sign-in \(bad creds\)\s+500/,
    ],
  ];
  try {
    for (const [name, answers, handoffSigning, problems, shown] of cases) {
      fakeProbes(answers);
      const verified = await captureOutput(() => releaseRunner.verify(config, profile, { handoffSigning }));
      assert.equal(verified.error, undefined, `${name}: ${verified.out}`);
      assert.deepEqual(verified.result, { healthy: problems.length === 0, problems }, name);
      assert.match(verified.out, shown, name);
    }
  } finally {
    globalThis.fetch = offline;
  }
});

test("F-51: a satellite that publishes a signing key fails its probe, and is told whether it is the kit's own key", async () => {
  const config = requireConfig(fixture("satellite").cliRoot);
  const profile = resolveProfile(config);
  const own = { kty: "OKP", crv: "Ed25519", kid: "sat-kid", x: "SATELLITE-PUBLIC-X" };
  const cases: [string, Record<string, { status: number; body?: unknown }>, string[], RegExp][] = [
    [
      "no key: healthy",
      satelliteAnswers([], [KIT_KEY]),
      [],
      /publishes no signing keys \(correct for a consumer\)/,
    ],
    [
      "the kit's own key",
      satelliteAnswers([{ ...KIT_KEY }], [KIT_KEY]),
      ["it publishes the KIT's own SSO signing key"],
      /It is the KIT's own signing key[\s\S]*Rotate the kit's SSO_HANDOFF_PRIVATE_KEY as well/,
    ],
    [
      "a key of its own",
      satelliteAnswers([own], [KIT_KEY]),
      ["it publishes 1 SSO signing key(s), which a consumer must never hold"],
      /It is not the kit's key: consumers verify against the issuer's key set, so they refuse what it signs\./,
    ],
    [
      // SSO_HANDOFF_KID pins any id: only the public key says whose it is.
      "its own key under the kit's kid",
      satelliteAnswers([{ ...own, kid: KIT_KEY.kid }], [KIT_KEY]),
      ["it publishes 1 SSO signing key(s), which a consumer must never hold"],
      /It is not the kit's key/,
    ],
    [
      "the issuer's key set unserved",
      satelliteAnswers([own]),
      ["it publishes 1 SSO signing key(s), which a consumer must never hold"],
      /Whether it is the KIT's own key is unknown: the issuer's key set was not served\./,
    ],
    [
      // The issuer's state is reported, never held against the satellite.
      "an issuer publishing nothing",
      satelliteAnswers([], []),
      [],
      /The configured issuer https:\/\/demo\.example\.com publishes an EMPTY key set/,
    ],
  ];
  try {
    for (const [name, answers, problems, shown] of cases) {
      fakeProbes(answers);
      const verified = await captureOutput(() =>
        releaseRunner.verify(config, profile, { handoffSigning: null }),
      );
      assert.equal(verified.error, undefined, `${name}: ${verified.out}`);
      assert.deepEqual(verified.result, { healthy: problems.length === 0, problems }, name);
      assert.match(verified.out, shown, name);
      if (problems.length > 0) {
        assert.match(
          verified.out,
          /Remove it from this satellite's project \(prj_sat\) with drk-deploy env:prune, then redeploy\./,
          name,
        );
        assert.doesNotMatch(verified.out, /mint handoff tokens the fleet will trust/, name);
      }
    }
  } finally {
    globalThis.fetch = offline;
  }
});

test("F-51: `deploy --yes` of a satellite that publishes a key, and of a kit that signs but publishes none, ends non-zero with the real probe", async () => {
  /** The recording fake, with the REAL probe in place of its verify. */
  const withRealProbe = (fake: ReturnType<typeof recordingRunner>) =>
    ({
      ...(fake.runner as object),
      verify: async (...received: Parameters<typeof releaseRunner.verify>) => {
        fake.calls.push("verify");
        return releaseRunner.verify(...received);
      },
    }) as never;
  try {
    // The finding's scenario: --yes skips the preflight that would have
    // caught the key, and the run used to end "healthy" with exit 0. The
    // rollback restores a build that publishes the same key (the probes
    // answer the same), so production still needs a person: exit 5.
    fakeProbes(satelliteAnswers([{ ...KIT_KEY }], [KIT_KEY]));
    const satellite = recordingRunner({ envProblems: 1 });
    const shown = await captureOutput(() =>
      deploy(fixture("satellite").cliRoot, { yes: true }, withRealProbe(satellite)),
    );
    assert.ok(
      refusal(
        /^The new build failed its probe \(it publishes the KIT's own SSO signing key\) and was rolled back/,
        /./,
        5,
      )(shown.error),
      `${String(shown.error)}\n${shown.out}`,
    );
    assert.deepEqual(satellite.calls.slice(-3), ["verify", "rollback", "verify"]);
    assert.doesNotMatch(shown.out, /is healthy\./);

    // The kit: production sets the key, the build publishes none. With no
    // rollback asked for, it stays live and exits 3 instead of 0.
    fakeProbes(kitAnswers([]));
    const kit = recordingRunner({ production: SIGNING_PRODUCTION });
    await assert.rejects(
      deploy(fixture("kit").cliRoot, { databaseUrl: PRODUCTION_DIRECT }, withRealProbe(kit)),
      refusal(
        /^The deployment is live but not healthy: it publishes an EMPTY SSO key set although production sets SSO_HANDOFF_PRIVATE_KEY\.$/,
        new RegExp(literal(ROLLBACK_COMMAND)),
        3,
      ),
    );
    assert.deepEqual(kit.calls, KIT_ORDER);
  } finally {
    globalThis.fetch = offline;
  }
});
