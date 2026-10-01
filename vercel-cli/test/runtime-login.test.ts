import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Tests run against the BUILT output, so they exercise exactly what ships.
import {
  planEnvWrites,
  rotatedLoginName,
  runtimeLogin,
  runtimeLoginRunner,
} from "../dist/commands/runtime-login.js";
import { CliError, setQuiet } from "../dist/lib/log.js";

/*
 * DEP4: `drk-deploy db:runtime-login` against a recording runner, so no test
 * reaches Vercel, the kit or a database: the order of its steps, each
 * refusal (exit 2, nothing written), the kit failure (exit 1, nothing
 * written), the failures after a write (exit 3), the env writes (sensitive,
 * an existing entry edited by id with its targets kept), the retire modes,
 * and that the generated password reaches the kit's environment and the
 * DATABASE_URL value and nothing else: not stdout, stderr, argv or a message.
 */

/** Every step the command reaches through the runner. */
const STEPS = [
  "tree",
  "project",
  "serving",
  "events",
  "listEnv",
  "ensureKit",
  "kit",
  "editEnv",
  "createEnv",
  "redeploy",
  "verify",
  "confirm",
];

const TOKEN = "test-token-that-never-leaves-this-process";
const AMBIENT = [
  "VERCEL_TOKEN",
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "NOW_ORG_ID",
  "NOW_PROJECT_ID",
  "PRODUCTION_DIRECT_DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "DATABASE_URL",
  "DB_RUNTIME_LOGIN_PASSWORD",
  "DB_SEARCH_PATH_VIA_OPTIONS",
];

const OWNER_SECRET = "owner-password-never-printed";
const OWNER_DIRECT = `postgresql://neondb_owner:${OWNER_SECRET}@ep-quiet-cell-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`;
const POOLED_HOST = "ep-quiet-cell-123456-pooler.us-east-2.aws.neon.tech";
const DIRECT_HOST = "ep-quiet-cell-123456.us-east-2.aws.neon.tech";

/** The minute the fake clock reads, and so the login every run here mints. */
const NOW = new Date(Date.UTC(2026, 9, 1, 12, 34, 56));
const LOGIN = "auth_app_202610011234";

const PREVIOUS = { id: "dpl_previous123", url: "kit-previous123.vercel.app" };
const REDEPLOYED = { id: "dpl_redeployed456", url: "kit-redeployed456.vercel.app" };

const gateLine = (
  user: string,
  runtime: "owner" | "non-owner",
  options: { host?: string; schema?: string } = {},
) =>
  `[deploy-gate] target host=${options.host ?? POOLED_HOST} port=5432 database=neondb schema=${options.schema ?? "auth"} user=${user} runtime=${runtime}`;

const LISTING = [
  { id: "env_db", key: "DATABASE_URL", target: ["production"], type: "sensitive", customEnvironmentIds: [] },
  {
    id: "env_sp",
    key: "DB_SEARCH_PATH_VIA_OPTIONS",
    target: ["production", "preview"],
    type: "sensitive",
    customEnvironmentIds: [],
  },
  {
    id: "env_other",
    key: "BETTER_AUTH_SECRET",
    target: ["production"],
    type: "sensitive",
    customEnvironmentIds: [],
  },
];

let workspace = "";
const savedEnv: Record<string, string | undefined> = {};
const savedFetch = globalThis.fetch;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "drk-deploy-runtime-login-"));
  for (const key of AMBIENT) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.VERCEL_TOKEN = TOKEN;
  process.env.PRODUCTION_DIRECT_DATABASE_URL = OWNER_DIRECT;
  globalThis.fetch = (async () => {
    throw new Error("a runtime-login test reached the network");
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

/** A throwaway CLI root: its config, a Vercel CLI stub that throws, and a kit checkout with the script. */
function fixture(target: "kit" | "satellite" = "kit"): { cliRoot: string; kitRoot: string } {
  const cliRoot = join(workspace, `cli-${++fixtures}`);
  const kitRoot = join(cliRoot, "kit");
  const appRoot = join(cliRoot, "app");
  const vcDir = join(cliRoot, "node_modules", "vercel", "dist");
  for (const dir of [kitRoot, appRoot, vcDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(vcDir, "vc.js"), 'throw new Error("a runtime-login test ran the Vercel CLI");\n');
  writeFileSync(
    join(kitRoot, "package.json"),
    JSON.stringify({ scripts: { "db:runtime-login": 'node -e "process.exit(97)"' } }),
  );
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
          satellite: {
            option: "standalone",
            appRoot,
            issuerOrigin: "https://demo.example.com",
            database: "own",
          },
          projectId: "prj_sat",
          origin: "https://app1.example.net",
          applicationId: "standalone",
        };
  writeFileSync(join(cliRoot, ".drk-deploy.json"), JSON.stringify(config));
  return { cliRoot, kitRoot };
}

interface FakeOptions {
  failAt?: string;
  changes?: string[];
  servings?: ({ id: string; url: string | null } | null)[];
  events?: Record<string, string[]>;
  listing?: unknown[];
  kitCode?: number;
  verdict?: { healthy: boolean; problems: string[] };
  answer?: string;
}

/** A runner that records each step and its arguments, and answers as `options` says. */
function recordingRunner(options: FakeOptions = {}) {
  const servings = [...(options.servings ?? [PREVIOUS, REDEPLOYED])];
  const events = options.events ?? {
    [PREVIOUS.id]: [
      "Running build",
      gateLine("neondb_owner", "owner"),
      "[deploy-gate] PASS schema current after 0.4s runtime=owner",
    ],
    [REDEPLOYED.id]: [
      gateLine(LOGIN, "non-owner"),
      "[deploy-gate] PASS schema current after 0.3s runtime=non-owner",
    ],
  };
  const calls: string[] = [];
  const every: Record<string, unknown[][]> = {};
  const runner = Object.fromEntries(
    STEPS.map((name) => [
      name,
      async (...received: unknown[]) => {
        calls.push(name);
        (every[name] ??= []).push(received);
        if (options.failAt === name) throw new Error(`${name} failed`);
        switch (name) {
          case "tree":
            return {
              root: received[0],
              notRepository: null,
              head: "1111111111111111111111111111111111111111",
              branch: "main",
              changes: options.changes ?? [],
              generated: [],
              pushedAs: ["origin/main"],
              release: { ref: "origin/main", commit: "1111111111111111111111111111111111111111" },
            };
          case "project":
            return {
              id: "prj_test",
              name: "kit",
              accountId: "team_test",
              framework: "nextjs",
              aliases: [],
              git: {},
            };
          case "serving":
            return servings.length > 0 ? servings.shift() : REDEPLOYED;
          case "events":
            return events[(received[1] as { id: string }).id] ?? [];
          case "listEnv":
            return options.listing ?? LISTING;
          case "kit":
            return options.kitCode ?? 0;
          case "verify":
            return options.verdict ?? { healthy: true, problems: [] };
          case "confirm":
            return options.answer ?? "";
          default:
            return undefined;
        }
      },
    ]),
  );
  return { runner: runner as never, calls, every };
}

/** Runs `fn` with this CLI's output captured (strings only: the test runner's own frames are binary). */
async function captureOutput(fn: () => Promise<unknown>): Promise<{ error: unknown; out: string }> {
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
    await fn();
    return { error: undefined, out: chunks.join("") };
  } catch (error) {
    return { error, out: chunks.join("") };
  } finally {
    setQuiet(true);
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/** Runs the command with the fixed clock. */
function run(cliRoot: string, options: Record<string, unknown>, runner: never) {
  return captureOutput(() => runtimeLogin(cliRoot, options, runner, () => NOW));
}

/** A rejection that is this CliError, by exit code and message. */
function assertExit(error: unknown, exitCode: number, message: RegExp): CliError {
  assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
  assert.equal(error.exitCode, exitCode, `${error.message}\n${error.hint ?? ""}`);
  assert.match(error.message, message);
  return error;
}

/** The password the run generated: what the kit's environment carried. */
function passwordOf(every: Record<string, unknown[][]>): string {
  const env = every.kit?.[0]?.[2] as Record<string, string | undefined>;
  const password = env?.DB_RUNTIME_LOGIN_PASSWORD;
  assert.ok(password, "the kit was handed a password");
  return password;
}

test("DEP4: the fake stands in for EVERY real step, so no test can reach Vercel or the kit", () => {
  assert.deepEqual(Object.keys(runtimeLoginRunner).sort(), [...STEPS].sort());
});

test("DEP4: rotatedLoginName is <schema>_app_ and the UTC minute", () => {
  assert.equal(rotatedLoginName("auth", NOW), LOGIN);
  assert.equal(
    rotatedLoginName("tenant_a", new Date(Date.UTC(2027, 0, 2, 3, 4))),
    "tenant_a_app_202701020304",
  );
});

test("DEP4: release tree → target identity → kit command → env writes → redeploy → proof, and the password goes nowhere else", async () => {
  const { cliRoot, kitRoot } = fixture();
  const { runner, calls, every } = recordingRunner();
  const { error, out } = await run(cliRoot, { redeploy: true }, runner);
  assert.equal(error, undefined, `${out}\n${(error as CliError | undefined)?.hint ?? ""}`);
  assert.deepEqual(calls, [
    "tree",
    "project",
    "serving",
    "events",
    "listEnv",
    "ensureKit",
    "kit",
    "editEnv",
    "editEnv",
    "redeploy",
    "serving",
    "verify",
    "events",
  ]);

  // The kit: the login and the pooled host as arguments, everything secret in the environment.
  const [root, args, env] = every.kit![0] as [string, string[], Record<string, string | undefined>];
  assert.equal(root, kitRoot);
  assert.deepEqual(args, ["--login", LOGIN, "--allow-remote", "--verify-host", POOLED_HOST]);
  const password = passwordOf(every);
  assert.match(password, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(env.DATABASE_URL, OWNER_DIRECT);
  assert.equal(env.DB_SCHEMA, "auth");
  assert.equal(env.DOTENV_CONFIG_PATH, devNull);
  assert.equal(env.VERCEL_TOKEN, undefined);
  assert.ok("DB_SEARCH_PATH_VIA_OPTIONS" in env && env.DB_SEARCH_PATH_VIA_OPTIONS === undefined);
  assert.deepEqual(every.ensureKit![0], [kitRoot, false]);

  // The writes: existing entries edited by id, sensitive, no target sent (so theirs are kept).
  const [[, dbEntry, dbChange], [, spEntry, spChange]] = every.editEnv as [
    unknown,
    { id: string; key: string },
    { value: string; type: string },
  ][];
  assert.deepEqual(dbEntry, { id: "env_db", key: "DATABASE_URL" });
  assert.deepEqual(Object.keys(dbChange).sort(), ["type", "value"]);
  assert.equal(dbChange.type, "sensitive");
  const url = new URL(dbChange.value);
  assert.deepEqual(
    [url.username, url.password, url.hostname, url.pathname, url.search],
    [LOGIN, password, POOLED_HOST, "/neondb", "?sslmode=require&channel_binding=require"],
  );
  assert.deepEqual(spEntry, { id: "env_sp", key: "DB_SEARCH_PATH_VIA_OPTIONS" });
  assert.deepEqual(spChange, { value: "0", type: "sensitive" });
  assert.equal(every.createEnv, undefined);

  // The redeploy: the serving deployment, with the token in that child's environment only.
  const [vercel, from] = every.redeploy![0] as [{ env: Record<string, string> }, unknown];
  assert.deepEqual(from, PREVIOUS);
  assert.equal(vercel.env.VERCEL_TOKEN, TOKEN);
  assert.deepEqual((every.events![1] as [unknown, unknown])[1], REDEPLOYED);

  assert.match(out, /DATABASE_URL production sensitive written/);
  assert.match(out, /DB_SEARCH_PATH_VIA_OPTIONS production,preview sensitive written/);
  assert.match(out, new RegExp(`Production connects as ${LOGIN} \\(runtime=non-owner\\)`));
  assert.match(out, new RegExp(`db:runtime-login --retire-except ${LOGIN}`));

  // The password: in the kit's environment and the DATABASE_URL value, nowhere else.
  assert.ok(!out.includes(password), "not in stdout or stderr");
  assert.ok(!out.includes(OWNER_SECRET), "nor the owner's");
  for (const step of STEPS) {
    for (const received of every[step] ?? []) {
      const text = JSON.stringify(received, (key, value) =>
        (step === "kit" && key === "DB_RUNTIME_LOGIN_PASSWORD") || (step === "editEnv" && key === "value")
          ? "[expected]"
          : value,
      );
      assert.ok(!text.includes(password), `not in the ${step} step's arguments`);
    }
  }
});

test("DEP4: a kit failure writes nothing to Vercel (exit 1), and says so without the password", async () => {
  const { cliRoot } = fixture();
  const { runner, calls, every } = recordingRunner({ kitCode: 1 });
  const { error, out } = await run(cliRoot, { redeploy: true }, runner);
  const err = assertExit(error, 1, /exited 1: nothing was written to Vercel/);
  assert.deepEqual(calls, ["tree", "project", "serving", "events", "listEnv", "ensureKit", "kit"]);
  const password = passwordOf(every);
  assert.ok(![out, err.message, err.hint ?? ""].join("\n").includes(password));
  assert.match(err.hint ?? "", /--plaintext-password/);
});

test("DEP4: after a kit failure, the hint retires a left-behind login with a command that runs, and says an owner build fails the ratchet meanwhile", async () => {
  const live = "auth_app_202609010000";
  const cases: [string, FakeOptions, Record<string, unknown>, RegExp[], RegExp[]][] = [
    // First adoption: production connects as the owner, which --retire-except refuses as a name.
    [
      "owner",
      { kitCode: 1 },
      {},
      [/ratchet/, /a push to the production branch included/, /db:runtime-login --retire-all`/],
      [/--retire-except/],
    ],
    // Rotation: production connects as a kit login, and the new one harms nothing.
    [
      "kit login",
      { kitCode: 1, events: { [PREVIOUS.id]: [gateLine(live, "non-owner")] } },
      {},
      [
        new RegExp(
          `does not affect production, which connects as ${live}: \`drk-deploy db:runtime-login --retire-except ${live}\``,
        ),
      ],
      [/ratchet/, /--retire-all/],
    ],
    // No gate line: either could be true, so both are named, each with the flag a retire run then needs.
    [
      "unknown",
      { kitCode: 1, events: { [PREVIOUS.id]: ["Running build"] } },
      { allowUnverifiedTarget: true, yes: true },
      [
        /is unknown/,
        /If it is the owner, .*ratchet.*--retire-all --allow-unverified-target`/,
        /--retire-except <that login> --force --allow-unverified-target`/,
      ],
      [],
    ],
  ];
  for (const [name, fake, options, present, absent] of cases) {
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner(fake);
    const { error } = await run(cliRoot, { redeploy: true, ...options }, runner);
    const err = assertExit(error, 1, /exited 1: nothing was written to Vercel/);
    assert.equal(calls.at(-1), "kit", name);
    const hint = err.hint ?? "";
    assert.match(hint, new RegExp(`If that line says ${LOGIN} exists but failed verification`), name);
    for (const pattern of present) assert.match(hint, pattern, name);
    for (const pattern of absent) assert.doesNotMatch(hint, pattern, name);
  }
});

test("DEP4: --dry-run reads, plans, and creates, writes and redeploys nothing", async () => {
  const { cliRoot, kitRoot } = fixture();
  const { runner, calls, every } = recordingRunner();
  const { error, out } = await run(cliRoot, { dryRun: true, redeploy: true }, runner);
  assert.equal(error, undefined, out);
  assert.deepEqual(calls, ["tree", "project", "serving", "events", "listEnv", "ensureKit"]);
  assert.deepEqual(every.ensureKit![0], [kitRoot, true]);
  assert.match(out, new RegExp(`--login ${LOGIN} --allow-remote --verify-host ${POOLED_HOST}`));
  assert.match(out, /edit env_db, targets kept \(production\), sensitive/);
  assert.match(out, /\[dry-run\] nothing was created or written/);
  assert.ok(!out.includes(OWNER_SECRET));
});

test("DEP4: refused before anything is read: a satellite, a pooled owner URL, flags that do not make one run", async () => {
  const cases: [Record<string, unknown>, RegExp, ("kit" | "satellite")?, string?][] = [
    [{}, /is for the kit's own production/, "satellite"],
    [{ force: true }, /^--force applies only to --retire-except and --retire-all\.$/],
    [{ retireAll: true, redeploy: true }, /^--redeploy cannot be combined with a retire mode\.$/],
    [{ retireAll: true, retireExcept: LOGIN }, /exclude each other/],
    [{ retireExcept: "neondb_owner" }, /is not a kit login name/],
    [{ endpoint: "both" }, /neither pooled nor direct/],
    [{ connectionLimit: "0" }, /--connection-limit must be -1/],
    [{ schema: "auth;drop" }, /is not a schema name/],
    [{}, /POOLED connection string/, "kit", OWNER_DIRECT.replace(DIRECT_HOST, POOLED_HOST)],
    // Unset, with the shell's DATABASE_URL never read in its place.
    [{}, /^No owner URL: set PRODUCTION_DIRECT_DATABASE_URL/, "kit", ""],
  ];
  for (const [options, message, target, owner] of cases) {
    if (owner !== undefined) process.env.PRODUCTION_DIRECT_DATABASE_URL = owner;
    if (owner === "") process.env.DATABASE_URL = OWNER_DIRECT;
    try {
      const { cliRoot } = fixture(target);
      const { runner, calls } = recordingRunner();
      const { error } = await run(cliRoot, options, runner);
      assertExit(error, 2, message);
      assert.deepEqual(calls, [], `nothing read for ${JSON.stringify(options)}`);
    } finally {
      process.env.PRODUCTION_DIRECT_DATABASE_URL = OWNER_DIRECT;
      delete process.env.DATABASE_URL;
    }
  }
});

test("DEP4: a dirty kit checkout is refused (exit 2) before anything else is read", async () => {
  const { cliRoot } = fixture();
  const { runner, calls } = recordingRunner({ changes: ["?? src/db/migrations/0009-wip.sql"] });
  const { error } = await run(cliRoot, {}, runner);
  assertExit(
    error,
    2,
    /uncommitted change\(s\), untracked files included: \?\? src\/db\/migrations\/0009-wip\.sql/,
  );
  assert.deepEqual(calls, ["tree"]);
});

test("DEP4: the target identity: another database, another schema, or no gate line is refused (exit 2) before anything is created", async () => {
  const toEvents = ["tree", "project", "serving", "events"];
  const cases: [FakeOptions, Record<string, unknown>, RegExp][] = [
    [
      {
        events: {
          [PREVIOUS.id]: [
            gateLine("neondb_owner", "owner", { host: "ep-other-999-pooler.us-east-2.aws.neon.tech" }),
          ],
        },
      },
      {},
      /the owner URL is not the database production uses/,
    ],
    [
      { events: { [PREVIOUS.id]: [gateLine("neondb_owner", "owner", { schema: "tenant_a" })] } },
      {},
      /checked schema `tenant_a`/,
    ],
    [{ events: { [PREVIOUS.id]: ["Running build"] } }, {}, /has no `\[deploy-gate\] target` line/],
    [{ servings: [null] }, {}, /serves no deployment/],
  ];
  for (const [fake, options, message] of cases) {
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner(fake);
    const { error, out } = await run(cliRoot, options, runner);
    const err = assertExit(error, 2, message);
    assert.deepEqual(calls, fake.servings ? ["tree", "project", "serving"] : toEvents);
    assert.ok(![out, err.message, err.hint ?? ""].join("\n").includes(OWNER_SECRET));
    // No gate line: a pre-gate build, or a prebuilt one drk-deploy promoted (the gate skips there),
    // and the build that prints one is the git integration's, not a redeploy of the prebuilt output.
    if (/target` line/.test(err.message)) {
      assert.match(err.hint ?? "", /`drk-deploy deploy` or `up` built on this machine and promoted prebuilt/);
      assert.match(err.hint ?? "", /production build by Vercel's git integration prints one/);
      assert.doesNotMatch(err.hint ?? "", /Redeploy production once/);
    }
  }
});

test("DEP4: --allow-unverified-target asks for the database name (unless --yes), and refuses a wrong one", async () => {
  const noLine = { [PREVIOUS.id]: ["Running build"], [REDEPLOYED.id]: [gateLine(LOGIN, "non-owner")] };
  {
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner({ events: noLine, answer: "otherdb" });
    const { error } = await run(cliRoot, { allowUnverifiedTarget: true }, runner);
    assertExit(error, 2, /the name typed is not the owner URL's database/);
    assert.deepEqual(calls, ["tree", "project", "serving", "events", "confirm"]);
  }
  {
    const { cliRoot } = fixture();
    const { runner, calls, every } = recordingRunner({ events: noLine, answer: "neondb" });
    const { error, out } = await run(cliRoot, { allowUnverifiedTarget: true }, runner);
    assert.equal(error, undefined, out);
    assert.match(String(every.confirm![0]![0]), /Type the database name \(neondb\)/);
    assert.match(out, /--allow-unverified-target: the owner URL was NOT checked/);
    assert.ok(calls.includes("kit"));
  }
  {
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner({ events: noLine });
    const { error, out } = await run(cliRoot, { allowUnverifiedTarget: true, yes: true }, runner);
    assert.equal(error, undefined, out);
    assert.ok(!calls.includes("confirm"));
  }
});

test("DEP4: refused when production already connects as the name this run would mint", async () => {
  const { cliRoot } = fixture();
  const { runner, calls } = recordingRunner({ events: { [PREVIOUS.id]: [gateLine(LOGIN, "non-owner")] } });
  const { error } = await run(cliRoot, {}, runner);
  assertExit(error, 2, new RegExp(`production already connects as ${LOGIN}`));
  assert.deepEqual(calls, ["tree", "project", "serving", "events"]);
});

test("DEP4: missing entries are created for Production, sensitive; --endpoint direct writes 1 and verifies on the direct host", async () => {
  const { cliRoot } = fixture();
  const { runner, calls, every } = recordingRunner({ listing: [] });
  const { error, out } = await run(cliRoot, { endpoint: "direct" }, runner);
  assert.equal(error, undefined, out);
  assert.deepEqual(calls, [
    "tree",
    "project",
    "serving",
    "events",
    "listEnv",
    "ensureKit",
    "kit",
    "createEnv",
    "createEnv",
  ]);
  assert.deepEqual((every.kit![0] as [string, string[]])[1], [
    "--login",
    LOGIN,
    "--allow-remote",
    "--verify-host",
    DIRECT_HOST,
  ]);
  const [[, db], [, sp]] = every.createEnv as [
    unknown,
    { key: string; value: string; type: string; target: string[] },
  ][];
  assert.deepEqual([db.key, db.type, db.target], ["DATABASE_URL", "sensitive", ["production"]]);
  assert.equal(new URL(db.value).hostname, DIRECT_HOST);
  assert.deepEqual(sp, {
    key: "DB_SEARCH_PATH_VIA_OPTIONS",
    value: "1",
    type: "sensitive",
    target: ["production"],
  });
  // Without --redeploy, the exact next step.
  assert.match(out, /vercel redeploy dpl_previous123 --target=production --scope=team_test/);
  assert.match(out, new RegExp(`user=${LOGIN} runtime=non-owner`));
});

test("DEP4: an env listing it cannot write through is refused before the login is created", async () => {
  const cases: [unknown[], RegExp][] = [
    [
      [
        { id: "a", key: "DATABASE_URL", target: ["production"], type: "sensitive", customEnvironmentIds: [] },
        {
          id: "b",
          key: "DATABASE_URL",
          target: ["production", "preview"],
          type: "encrypted",
          customEnvironmentIds: [],
        },
      ],
      /2 DATABASE_URL entries cover Production/,
    ],
    [
      [
        {
          id: "a",
          key: "DATABASE_URL",
          target: ["production", "development"],
          type: "encrypted",
          customEnvironmentIds: [],
        },
      ],
      /also covers Development/,
    ],
  ];
  for (const [listing, message] of cases) {
    assert.throws(() => planEnvWrites(listing as never), message);
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner({ listing });
    const { error } = await run(cliRoot, {}, runner);
    assertExit(error, 2, message);
    assert.deepEqual(calls, ["tree", "project", "serving", "events", "listEnv"]);
  }
});

test("DEP4: every failure after a write exits 3 with the way back, and never prints the password", async () => {
  const cases: [FakeOptions, RegExp, RegExp][] = [
    // Nothing names the new login yet, so an owner build fails the ratchet until a rerun or --retire-all.
    [
      { failAt: "editEnv" },
      /^Writing DATABASE_URL failed: editEnv failed$/,
      /Production is unchanged.*ratchet.*db:runtime-login --retire-all`/,
    ],
    // DATABASE_URL already names it: retiring it would break the next build, so rerun instead.
    [
      { failAt: "editEnv", listing: [LISTING[1]] },
      /^Writing DB_SEARCH_PATH_VIA_OPTIONS failed: editEnv failed$/,
      new RegExp(`${LOGIN} exists, and DATABASE_URL already names it, so do not retire it`),
    ],
    [
      { failAt: "redeploy" },
      /^The redeploy failed: redeploy failed$/,
      /break-glass in docs\/deployment\.md §8\.5/,
    ],
    [
      { servings: [PREVIOUS, PREVIOUS] },
      /still serves https:\/\/kit-previous123\.vercel\.app/,
      /did not assign the production domain/,
    ],
    [
      { verdict: { healthy: false, problems: ["its health probes fail (see above)"] } },
      /is not healthy/,
      /vercel promote dpl_previous123 --scope=team_test/,
    ],
    [
      {
        events: {
          [PREVIOUS.id]: [gateLine("neondb_owner", "owner")],
          [REDEPLOYED.id]: [gateLine("neondb_owner", "owner")],
        },
      },
      new RegExp(`shows user=neondb_owner runtime=owner, not user=${LOGIN} runtime=non-owner`),
      /vercel promote dpl_previous123/,
    ],
    [{ failAt: "verify" }, /^Could not check the redeployed production: verify failed$/, /vercel promote/],
  ];
  for (const [fake, message, hint] of cases) {
    const { cliRoot } = fixture();
    const { runner, every } = recordingRunner(fake);
    const { error, out } = await run(cliRoot, { redeploy: true }, runner);
    const err = assertExit(error, 3, message);
    assert.match(err.hint ?? "", hint);
    const password = passwordOf(every);
    assert.ok(
      ![out, err.message, err.hint ?? ""].join("\n").includes(password),
      `no password: ${err.message}`,
    );
  }
});

test("DEP4: --retire-except must name the login production connects as (or --force), and passes no password", async () => {
  const live = "auth_app_202609010000";
  const events = { [PREVIOUS.id]: [gateLine(live, "non-owner")] };
  {
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner({ events });
    const { error } = await run(cliRoot, { retireExcept: "auth_app_202608010000" }, runner);
    assertExit(
      error,
      2,
      new RegExp(`Refusing to retire every login but auth_app_202608010000: production connects as ${live}`),
    );
    assert.deepEqual(calls, ["tree", "project", "serving", "events"]);
  }
  {
    const { cliRoot, kitRoot } = fixture();
    const { runner, calls, every } = recordingRunner({ events });
    const { error, out } = await run(cliRoot, { retireExcept: live }, runner);
    assert.equal(error, undefined, out);
    assert.deepEqual(calls, ["tree", "project", "serving", "events", "ensureKit", "kit"]);
    const [root, args, env] = every.kit![0] as [string, string[], Record<string, string | undefined>];
    assert.equal(root, kitRoot);
    assert.deepEqual(args, ["--retire-except", live, "--allow-remote"]);
    assert.equal(env.DB_RUNTIME_LOGIN_PASSWORD, undefined);
    assert.ok("DB_RUNTIME_LOGIN_PASSWORD" in env, "removed, not just absent");
    assert.equal(env.DATABASE_URL, OWNER_DIRECT);
  }
  {
    const { cliRoot } = fixture();
    const { runner, every } = recordingRunner({ events });
    const { error, out } = await run(cliRoot, { retireExcept: "auth_app_202608010000", force: true }, runner);
    assert.equal(error, undefined, out);
    assert.deepEqual((every.kit![0] as [string, string[]])[1], [
      "--retire-except",
      "auth_app_202608010000",
      "--allow-remote",
      "--force",
    ]);
  }
  {
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner({ events, kitCode: 1 });
    const { error } = await run(cliRoot, { retireExcept: live }, runner);
    assertExit(error, 1, /exited 1: see its lines above/);
    assert.deepEqual(calls.at(-1), "kit");
  }
  // Production on the owner: --retire-except can name no login it uses, so both refusals point at --retire-all.
  {
    const { cliRoot } = fixture();
    const { runner } = recordingRunner();
    const { error } = await run(cliRoot, { retireExcept: live }, runner);
    const err = assertExit(error, 2, /production connects as neondb_owner/);
    assert.match(
      err.hint ?? "",
      /not a kit login, so no rotated login is in use.*db:runtime-login --retire-all`/,
    );
  }
  {
    const { cliRoot } = fixture();
    const { runner } = recordingRunner();
    const { error } = await run(cliRoot, { retireExcept: "neondb_owner" }, runner);
    const err = assertExit(error, 2, /is not a kit login name/);
    assert.match(err.hint ?? "", /--retire-all/);
  }
});

test("DEP4: --retire-all is refused while production connects as a kit login, and runs once it connects as the owner", async () => {
  {
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner({
      events: { [PREVIOUS.id]: [gateLine("auth_app_202609010000", "non-owner")] },
    });
    const { error } = await run(cliRoot, { retireAll: true }, runner);
    const err = assertExit(error, 2, /production connects as auth_app_202609010000, a kit login/);
    assert.deepEqual(calls, ["tree", "project", "serving", "events"]);
    // An owner redeploy fails the ratchet while the logins exist, so the hint never offers it
    // before the retire: after a rotation the way out is --force first, then the redeploy.
    const hint = err.hint ?? "";
    assert.doesNotMatch(hint, /point its DATABASE_URL at the owner and redeploy/);
    assert.match(hint, /after a rotation the recent ones all connect as a login/);
    assert.match(hint, /rerun with --force, which cuts production off until the next step is live/);
    assert.match(hint, /the retire has to come before that redeploy/);
  }
  {
    const { cliRoot } = fixture();
    const { runner, every } = recordingRunner();
    const { error, out } = await run(cliRoot, { retireAll: true }, runner);
    assert.equal(error, undefined, out);
    assert.deepEqual((every.kit![0] as [string, string[]])[1], ["--retire-all", "--allow-remote"]);
  }
  {
    const { cliRoot } = fixture();
    const { runner, calls } = recordingRunner();
    const { error, out } = await run(cliRoot, { retireAll: true, dryRun: true }, runner);
    assert.equal(error, undefined, out);
    assert.deepEqual(calls, ["tree", "project", "serving", "events", "ensureKit"]);
    assert.match(out, /\[dry-run\] would run the kit command above/);
  }
});
