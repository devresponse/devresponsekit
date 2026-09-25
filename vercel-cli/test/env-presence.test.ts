import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

// Tests run against the BUILT output, so they exercise exactly what ships.
import { dbProvision } from "../dist/commands/db.js";
import { envCheck, envPrune, envSync } from "../dist/commands/env.js";
import { deploy, releaseRunner } from "../dist/commands/release.js";
import { useConfigFile } from "../dist/lib/config.js";
import { isPresent, presenceFor, readPublicValues, storedProblems } from "../dist/lib/env-presence.js";
import {
  ENV_SPECS,
  FORBIDDEN_ON_VERCEL,
  SATELLITE_ISSUER_ONLY,
  derivedValuesFor,
  envSpecsFor,
  pinnedValuesFor,
  specFor,
} from "../dist/lib/env-spec.js";
import { CliError } from "../dist/lib/log.js";
import { resolveProfile } from "../dist/lib/target.js";

/* ================================================================== */
/*  F-46: what counts as set, and what is checked about it            */
/* ================================================================== */

const KIT = {
  projectId: "prj_kit",
  teamId: "team_test",
  origin: "https://demo.example.com",
  appName: "Example",
  audiencePrefix: "devresponse-app",
  applicationId: "portal",
};

function contextOf(config: Record<string, unknown>) {
  return {
    profile: resolveProfile(config as never),
    origin: config.origin as string,
    appName: config.appName as string,
    audiencePrefix: config.audiencePrefix as string,
    applicationId: config.applicationId as string,
  };
}

const PINNED: Record<string, string> = pinnedValuesFor(contextOf(KIT) as never);
const PROD = ["production"];
const ALL = ["production", "preview", "development"];

/** One entry as `listEnv` hands it on: `value` only where Vercel returned it in the clear. */
function entry(
  key: string,
  fields: {
    id?: string;
    target?: string[];
    type?: string;
    value?: string;
    gitBranch?: string;
    customEnvironmentIds?: string[];
  } = {},
) {
  return {
    id: fields.id ?? `env_${key}`,
    key,
    target: fields.target ?? ["production"],
    type: fields.type ?? "plain",
    customEnvironmentIds: fields.customEnvironmentIds ?? [],
    ...(fields.gitBranch ? { gitBranch: fields.gitBranch } : {}),
    ...(fields.value !== undefined ? { value: fields.value } : {}),
  };
}

function spec(key: string) {
  const found = specFor(key);
  assert.ok(found, `${key} is in the kit's contract`);
  return found;
}

test("a DATABASE_URL set only for Development is MISSING for a production deploy", () => {
  const listing = [entry("DATABASE_URL", { target: ["development"], type: "encrypted" })];
  const presence = presenceFor(listing, "DATABASE_URL", PROD);
  assert.equal(isPresent(presence), false, "the finding's case (b): it used to read as `set development`");
  assert.deepEqual(presence.missing, ["production"]);
  assert.deepEqual(presence.serving, []);
  assert.deepEqual(presence.elsewhere, ["development"], "named, so MISSING is not a mystery");
  assert.equal(isPresent(presenceFor(listing, "DATABASE_URL", ["development"])), true);

  // Several entries may share the targets, as Vercel allows. One short is not enough.
  const production = entry("DATABASE_URL", { target: ["production"], type: "encrypted" });
  const rest = entry("DATABASE_URL", { id: "env_2", target: ["preview", "development"], type: "encrypted" });
  assert.equal(isPresent(presenceFor([production, rest], "DATABASE_URL", ALL)), true);
  assert.deepEqual(presenceFor([production], "DATABASE_URL", ALL).missing, ["preview", "development"]);
});

test("an entry scoped to a git branch or a custom environment is not the target's", () => {
  const branch = entry("SSO_HANDOFF_ISSUER", {
    target: ["preview"],
    gitBranch: "feat-x",
    value: "https://demo.example.com",
  });
  const onBranch = presenceFor([branch], "SSO_HANDOFF_ISSUER", ["preview"]);
  assert.equal(isPresent(onBranch), false, "the target's other deployments do not read it");
  assert.deepEqual(onBranch.elsewhere, ["preview (git branch feat-x)"]);

  const custom = entry("DATABASE_URL", {
    target: ["production"],
    type: "encrypted",
    customEnvironmentIds: ["env_staging"],
  });
  assert.equal(isPresent(presenceFor([custom], "DATABASE_URL", PROD)), false);
});

test("a plain httsp:// issuer is a problem: the kit's own origin rule, and the derived value", () => {
  const issuer = spec("SSO_HANDOFF_ISSUER");
  const presence = presenceFor(
    [entry("SSO_HANDOFF_ISSUER", { value: "httsp://demo.example.com" })],
    issuer.key,
    PROD,
  );
  assert.equal(isPresent(presence), true, "it IS set; presence was never the question");
  const problems = storedProblems(issuer, presence, PINNED.SSO_HANDOFF_ISSUER);
  assert.equal(problems.length, 1);
  assert.equal(
    problems[0].why,
    'production: "httsp://demo.example.com" must use the http: or https: scheme, not "httsp:"; expected "https://demo.example.com" (derived from the recorded config)',
  );
  assert.equal(
    problems[0].fix,
    "Replace it: remove it (`vercel env rm SSO_HANDOFF_ISSUER production`, or delete it in the dashboard), then `drk-deploy env:sync` re-creates it as plain from the recorded config. Redeploy for it to take effect.",
    "not `env:sync --force`, which regenerates every secret it may",
  );
});

test("a plain value that differs from the one this CLI derives is a problem, expected vs found", () => {
  const issuer = spec("SSO_HANDOFF_ISSUER");
  const presence = presenceFor(
    [entry("SSO_HANDOFF_ISSUER", { value: "https://other.example.com" })],
    issuer.key,
    PROD,
  );
  const [problem, ...rest] = storedProblems(issuer, presence, PINNED.SSO_HANDOFF_ISSUER);
  assert.deepEqual(rest, []);
  assert.equal(
    problem?.why,
    'production: expected "https://demo.example.com" (derived from the recorded config), found "https://other.example.com"',
  );
  assert.match(problem?.fix ?? "", /the recorded config is wrong instead: correct it with `drk-deploy init`/);

  // EVERY pinned key is compared, on the kit and on an Option C satellite
  // (the one that derives COOKIE_DOMAIN): the origin and the SSO identity.
  // The two derived only as defaults are not, so an operator's product name
  // does not stop a deploy. All of them are public, which is what makes
  // printing expected and found safe.
  const identity = [
    "BETTER_AUTH_URL",
    "NEXT_PUBLIC_APP_URL",
    "SSO_HANDOFF_APPLICATION_ID",
    "SSO_HANDOFF_AUDIENCE_PREFIX",
    "SSO_HANDOFF_ISSUER",
  ];
  const shared = {
    ...KIT,
    target: "satellite",
    satellite: {
      option: "shared",
      appRoot: "C:\\apps\\app-shared",
      issuerOrigin: "https://demo.example.com",
      cookieDomain: ".example.com",
    },
    origin: "https://app3.example.com",
    applicationId: "shared",
  };
  for (const [config, expectedPins] of [
    [KIT, identity],
    [shared, [...identity, "COOKIE_DOMAIN"]],
  ] as const) {
    const context = contextOf(config);
    const specs = envSpecsFor(context as never);
    const derived: Record<string, string> = derivedValuesFor(context as never);
    const pinned: Record<string, string> = pinnedValuesFor(context as never);
    assert.deepEqual(Object.keys(pinned).sort(), [...expectedPins].sort());
    for (const [key, value] of Object.entries(derived)) {
      const keySpec = specs.find((s) => s.key === key);
      assert.ok(keySpec, `${key} is derived, so it must be in the contract`);
      assert.equal(keySpec.secret, false, `${key} is derived, so it is public`);
      const as = (stored: string) => presenceFor([entry(key, { value: stored })], key, PROD);
      assert.deepEqual(storedProblems(keySpec, as(value), pinned[key]), [], `${key} as derived`);
      assert.equal(
        storedProblems(keySpec, as(`${value}x`), pinned[key]).length,
        key in pinned ? 1 : 0,
        `${key} differing`,
      );
    }
  }
  assert.deepEqual(
    Object.keys(derivedValuesFor(contextOf(KIT) as never)).filter((key) => !(key in PINNED)),
    ["NEXT_PUBLIC_PRODUCTION_HOST", "NEXT_PUBLIC_APP_NAME"],
    "derived only as defaults",
  );
});

test("a public value stored write-only is a problem, and the fix is exact", () => {
  const issuer = spec("SSO_HANDOFF_ISSUER");
  // The recorded incident's storage. `encrypted` lands here only when it
  // could not be read back (see readPublicValues).
  for (const type of ["sensitive", "encrypted"]) {
    const presence = presenceFor([entry(issuer.key, { type })], issuer.key, PROD);
    assert.deepEqual(storedProblems(issuer, presence, PINNED.SSO_HANDOFF_ISSUER), [
      {
        why: `production: public value stored write-only (\`${type}\`), so it cannot be read back or verified`,
        fix: "Re-store it as plain: remove it (`vercel env rm SSO_HANDOFF_ISSUER production`, or delete it in the dashboard), then `drk-deploy env:sync` re-creates it as plain from the recorded config. Redeploy for it to take effect.",
      },
    ]);
  }

  // A supplied public value cannot be re-derived, so the fix says where it comes from.
  const suffixes = spec("SSO_ALLOWED_ORIGIN_SUFFIXES");
  const [supplied] = storedProblems(
    suffixes,
    presenceFor([entry(suffixes.key, { type: "sensitive" })], suffixes.key, PROD),
  );
  assert.match(
    supplied?.fix ?? "",
    /then `drk-deploy env:sync --from-env <file>` \(or the value exported in the shell\) writes it back as plain/,
  );

  // One derived only as a default: a supplied value wins, or else the default is derived again.
  const name = spec("NEXT_PUBLIC_APP_NAME");
  const [cosmetic] = storedProblems(
    name,
    presenceFor([entry(name.key, { type: "sensitive" })], name.key, PROD),
    PINNED[name.key],
  );
  assert.match(
    cosmetic?.fix ?? "",
    /then `drk-deploy env:sync` writes it back as plain: the value from `--from-env <file>` or the shell, or else the default the recorded config derives\./,
  );

  // Syncing Preview too names both removals and the target flag.
  const both = ["production", "preview"];
  const [preview] = storedProblems(
    issuer,
    presenceFor([entry(issuer.key, { type: "sensitive", target: both })], issuer.key, both),
    PINNED.SSO_HANDOFF_ISSUER,
  );
  assert.match(
    preview?.fix ?? "",
    /`vercel env rm SSO_HANDOFF_ISSUER production and vercel env rm SSO_HANDOFF_ISSUER preview`/,
  );
  assert.match(preview?.fix ?? "", /`drk-deploy env:sync --target production,preview`/);
});

test("a secret stored sensitive is fine: secrets are never read, and never quoted", () => {
  for (const key of ["BETTER_AUTH_SECRET", "DATABASE_URL", "SSO_HANDOFF_PRIVATE_KEY", "CRON_SECRET"]) {
    for (const type of ["sensitive", "encrypted"]) {
      const presence = presenceFor([entry(key, { type })], key, PROD);
      assert.equal(isPresent(presence), true);
      assert.deepEqual(storedProblems(spec(key), presence, PINNED[key]), [], `${key} stored ${type}`);
    }
  }
  // One stored `plain` arrives with the listing anyway: validated, never quoted.
  const [problem] = storedProblems(
    spec("DATABASE_URL"),
    presenceFor([entry("DATABASE_URL", { value: "mysql://app:hunter2@db/app" })], "DATABASE_URL", PROD),
  );
  assert.equal(problem?.why, "production: the stored value must be a postgres:// URL");
  assert.ok(!`${problem?.why} ${problem?.fix}`.includes("hunter2"), "a secret's value is never printed");
});

test("Development is checked for presence only: a localhost origin is correct there", () => {
  const url = spec("BETTER_AUTH_URL");
  const presence = presenceFor(
    [entry(url.key, { target: ["development"], value: "http://localhost:3000" })],
    url.key,
    ["development"],
  );
  assert.equal(isPresent(presence), true);
  assert.deepEqual(storedProblems(url, presence, PINNED.BETTER_AUTH_URL), []);
});

test("an encrypted PUBLIC value is read back to be verified; a secret is never fetched", async () => {
  const listing = [
    entry("SSO_HANDOFF_APPLICATION_ID", { id: "env_app", type: "encrypted" }),
    entry("DATABASE_URL", { id: "env_db", type: "encrypted" }),
    entry("BETTER_AUTH_SECRET", { id: "env_secret", type: "sensitive" }),
    entry("SSO_HANDOFF_ISSUER", { id: "env_iss", type: "sensitive" }),
    entry("NEXT_PUBLIC_APP_URL", { id: "env_dev", type: "encrypted", target: ["development"] }),
    entry("BETTER_AUTH_URL", { id: "env_plain", value: "https://demo.example.com" }),
  ];
  const asked: string[] = [];
  const read = await readPublicValues(listing, ENV_SPECS, PROD, async (e: { id: string }) => {
    asked.push(e.id);
    return "someone-else";
  });
  assert.deepEqual(
    asked,
    ["env_app"],
    "not the secret, not the sensitive one, not another target's, not a plain one",
  );
  const app = presenceFor(read, "SSO_HANDOFF_APPLICATION_ID", PROD);
  assert.equal(app.serving[0]?.value, "someone-else");
  assert.equal(presenceFor(read, "DATABASE_URL", PROD).serving[0]?.value, undefined);
  assert.equal(
    storedProblems(spec("SSO_HANDOFF_APPLICATION_ID"), app, PINNED.SSO_HANDOFF_APPLICATION_ID)[0]?.why,
    'production: expected "portal" (derived from the recorded config), found "someone-else"',
    "what it read back is held to the derived value like a plain one",
  );
});

/* ================================================================== */
/*  F-46: the same rules through the real commands                     */
/* ================================================================== */

// env:check, env:sync and deploy's preflight, run for real against a fake
// Vercel API: `fetch` is replaced, so the SDK, listEnv and readEnvValue run
// as shipped and nothing leaves the process. The operator's shell can hold
// real values for every one of these keys (this CLI is linked to a
// production project where it is developed), so all of them are scrubbed.

const SCRUBBED = [
  ...new Set([
    ...ENV_SPECS.map((s) => s.key),
    ...SATELLITE_ISSUER_ONLY.map((f) => f.key),
    ...FORBIDDEN_ON_VERCEL.map((f) => f.key),
    "COOKIE_DOMAIN",
    "DB_SCHEMA",
    "ADMIN_TRUSTED_ORIGINS",
    "VERCEL_TOKEN",
    "VERCEL_ORG_ID",
    "VERCEL_PROJECT_ID",
    "PRODUCTION_DIRECT_DATABASE_URL",
    "DIRECT_DATABASE_URL",
    "SATELLITE_DIRECT_DATABASE_URL",
  ]),
];

let workspace = "";
let fixtures = 0;
const savedEnv: Record<string, string | undefined> = {};
const savedFetch = globalThis.fetch;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "drk-deploy-env-"));
  for (const key of SCRUBBED) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.VERCEL_TOKEN = "test-token-that-never-leaves-this-process";
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

after(() => {
  globalThis.fetch = savedFetch;
  for (const key of SCRUBBED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(workspace, { recursive: true, force: true });
});

/** A CLI root configured for the kit, with a Vercel CLI stub that throws if run. */
function kitCli(): string {
  const cliRoot = join(workspace, `cli-${++fixtures}`);
  const kitRoot = join(cliRoot, "kit");
  const vcDir = join(cliRoot, "node_modules", "vercel", "dist");
  for (const dir of [kitRoot, vcDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(vcDir, "vc.js"), 'throw new Error("an env test ran the Vercel CLI");\n');
  writeFileSync(join(cliRoot, ".drk-deploy.json"), JSON.stringify({ ...KIT, kitRoot }));
  return cliRoot;
}

/** A --from-env file supplying the one value nothing can derive or generate, and any `extra`. */
function databaseUrlFile(extra: Record<string, string> = {}): string {
  const file = join(workspace, `supplied-${++fixtures}.env`);
  const lines = Object.entries({ DATABASE_URL: "postgresql://app@db.example.com/app", ...extra });
  writeFileSync(file, lines.map(([key, value]) => `${key}=${value}\n`).join(""));
  return file;
}

/** One variable as the Vercel API lists it. */
function raw(key: string, type: string, value = "", target: string[] | string = ["production"]) {
  return { id: `env_${key}`, key, type, value, target, securityIssues: [] };
}

const CIPHERTEXT = "v2:9f3a0c-not-a-value";

/** The production environment `drk-deploy env:sync` leaves behind, with a dashboard edit or two. */
function healthy() {
  return [
    raw("BETTER_AUTH_SECRET", "sensitive"),
    raw("BETTER_AUTH_URL", "plain", "https://demo.example.com"),
    // A bare-string target, which the API also answers with.
    raw("DATABASE_URL", "encrypted", CIPHERTEXT, "production"),
    raw("SSO_HANDOFF_ISSUER", "plain", "https://demo.example.com"),
    raw("SSO_HANDOFF_AUDIENCE_PREFIX", "plain", "devresponse-app"),
    // Edited in the dashboard, which stores `encrypted`: read back below.
    raw("SSO_HANDOFF_APPLICATION_ID", "encrypted", CIPHERTEXT),
    raw("SSO_HANDOFF_PRIVATE_KEY", "sensitive"),
    raw("SSO_ALLOWED_ORIGIN_SUFFIXES", "plain", "example.com"),
    raw("CRON_SECRET", "sensitive"),
    raw("NEXT_PUBLIC_APP_URL", "plain", "https://demo.example.com"),
  ];
}

function replace(listing: ReturnType<typeof healthy>, ...entries: ReturnType<typeof raw>[]) {
  const keys = new Set(entries.map((e) => e.key));
  return [...listing.filter((e) => !keys.has(e.key)), ...entries];
}

/**
 * A fake Vercel API: the listing, the read-back of an encrypted value, and the
 * writes. `stateful` lists every write afterwards, as Vercel does, so a second
 * run sees what the first one wrote.
 */
function fakeVercel(
  listing: ReturnType<typeof raw>[],
  decrypted: Record<string, string> = { env_SSO_HANDOFF_APPLICATION_ID: "portal" },
  stateful = false,
) {
  const reads: string[] = [];
  const writes: Array<{ key: string; type: string; target: string[]; value: string }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.vercel.com") throw new Error(`an env test reached ${url.hostname}`);
    if (request.method === "GET" && /^\/v10\/projects\/prj_kit\/env$/.test(url.pathname)) {
      return json({ envs: listing, pagination: { count: listing.length, next: null, prev: null } });
    }
    const one = /^\/v1\/projects\/prj_kit\/env\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && one) {
      const id = one[1]!;
      reads.push(id);
      const found = listing.find((e) => e.id === id);
      if (!found) return new Response("{}", { status: 404 });
      const value = decrypted[id];
      // A sensitive variable answers without a value.
      return json(
        value === undefined
          ? { id, key: found.key, type: found.type, target: found.target, decrypted: false }
          : { id, key: found.key, type: found.type, target: found.target, value, decrypted: true },
      );
    }
    if (request.method === "POST" && /^\/v10\/projects\/prj_kit\/env$/.test(url.pathname)) {
      const written = JSON.parse(await request.text()) as (typeof writes)[number];
      writes.push(written);
      if (stateful) {
        // The listing returns a plain value in the clear, ciphertext for an encrypted one.
        const listed = written.type === "plain" ? written.value : CIPHERTEXT;
        listing.push({
          ...raw(written.key, written.type, listed, written.target),
          id: `env_w${writes.length}`,
        });
      }
      return json({ failed: [] }, 201);
    }
    throw new Error(`an env test made an unexpected call: ${request.method} ${url.pathname}`);
  }) as typeof fetch;
  return { reads, writes };
}

/** Runs a command with its output captured: stdout and stderr, colour-free. */
async function run<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; out: string }> {
  const chunks: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const sink = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    return { result: await fn(), out: chunks.join("") };
  } catch (error) {
    return { error, out: chunks.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("env:check: a healthy production environment passes, and only an encrypted PUBLIC value is read back", async () => {
  const vercel = fakeVercel(healthy());
  const { result, error, out } = await run(() => envCheck(kitCli()));
  assert.equal(error, undefined, out);
  assert.equal(result, 0, out);
  assert.deepEqual(
    vercel.reads,
    ["env_SSO_HANDOFF_APPLICATION_ID"],
    "DATABASE_URL is encrypted too, and never read",
  );
  assert.match(out, /SSO_HANDOFF_ISSUER\s+set production plain, value checked/);
  assert.match(out, /DATABASE_URL\s+set production encrypted\n/);
});

test("env:check: the recorded incident, an httsp:// issuer stored sensitive, stops deploy before it migrates", async () => {
  fakeVercel(replace(healthy(), raw("SSO_HANDOFF_ISSUER", "sensitive")));
  const cliRoot = kitCli();
  const check = await run(() => envCheck(cliRoot));
  assert.equal(check.result, 1, check.out);
  assert.match(check.out, /SSO_HANDOFF_ISSUER\s+WRONG/);
  assert.match(
    check.out,
    /public value stored write-only \(`sensitive`\), so it cannot be read back or verified/,
  );
  assert.match(check.out, /Re-store it as plain: remove it \(`vercel env rm SSO_HANDOFF_ISSUER production`/);

  // deploy's preflight IS env:check: every other step is a recording fake.
  const calls: string[] = [];
  const record = (name: string) => async (): Promise<undefined> => {
    calls.push(name);
    return undefined;
  };
  const runner = {
    ...Object.fromEntries(
      ["envSync", "migrate", "link", "pull", "build", "promote", "verify"].map((n) => [n, record(n)]),
    ),
    envCheck: releaseRunner.envCheck,
  };
  const shipped = await run(() => deploy(cliRoot, {}, runner as never));
  assert.ok(shipped.error instanceof CliError, shipped.out);
  assert.equal(shipped.error.message, "1 environment problem(s).");
  assert.deepEqual(calls, [], "nothing was migrated, built or promoted");
});

test("env:check: a DATABASE_URL set only for Development is MISSING, and says where it is", async () => {
  fakeVercel(replace(healthy(), raw("DATABASE_URL", "encrypted", CIPHERTEXT, ["development"])));
  const { result, out } = await run(() => envCheck(kitCli()));
  assert.equal(result, 1, out);
  assert.match(
    out,
    /DATABASE_URL\s+MISSING — The server will not boot\. \(on Vercel only for development, not production\)/,
  );
});

test("env:sync: a DATABASE_URL set only for Development is not 'unchanged', so up stops; supplied, it is written to production", async () => {
  const listing = replace(healthy(), raw("DATABASE_URL", "encrypted", CIPHERTEXT, ["development"]));
  const refused = fakeVercel(listing);
  const { error, out } = await run(() => envSync(kitCli(), {}));
  assert.ok(error instanceof CliError, out);
  assert.equal(error.message, "1 required variable(s) unresolved.");
  assert.match(out, /DATABASE_URL\s+no value available \(on Vercel only for development, not production\)/);
  assert.doesNotMatch(out, /unchanged \(already set\): [^\n]*DATABASE_URL/);
  assert.deepEqual(refused.writes, [], "nothing is written when the sync refuses");

  const supplied = fakeVercel(listing);
  const written = await run(() => envSync(kitCli(), { fromEnv: databaseUrlFile() }));
  assert.equal(written.error, undefined, written.out);
  const database = supplied.writes.find((w) => w.key === "DATABASE_URL");
  assert.deepEqual(database?.target, ["production"]);
  assert.equal(database?.type, "encrypted");
});

test("env:sync: a stored httsp:// issuer stops the sync, and so up, before anything is written", async () => {
  const vercel = fakeVercel(
    replace(healthy(), raw("SSO_HANDOFF_ISSUER", "plain", "httsp://demo.example.com")),
  );
  const { error, out } = await run(() => envSync(kitCli(), {}));
  assert.ok(error instanceof CliError, out);
  assert.equal(error.message, "1 variable(s) already set on Vercel fail the contract.");
  assert.match(out, /Set on Vercel, but wrong or unverifiable/);
  assert.match(
    out,
    /SSO_HANDOFF_ISSUER\s+production: "httsp:\/\/demo\.example\.com" must use the http: or https: scheme/,
  );
  assert.match(out, /`vercel env rm SSO_HANDOFF_ISSUER production`/);
  assert.deepEqual(vercel.writes, []);
});

test("env:sync --force: a secret set only for Development is not a rotation; one set for Production is", async () => {
  const devOnly = fakeVercel([raw("BETTER_AUTH_SECRET", "sensitive", "", ["development"])]);
  const quiet = await run(() => envSync(kitCli(), { force: true, fromEnv: databaseUrlFile() }));
  assert.equal(quiet.error, undefined, quiet.out);
  assert.doesNotMatch(quiet.out, /ROTATE/);
  assert.deepEqual(devOnly.writes.find((w) => w.key === "BETTER_AUTH_SECRET")?.target, ["production"]);

  const live = fakeVercel([raw("BETTER_AUTH_SECRET", "sensitive")]);
  const rotation = await run(() => envSync(kitCli(), { force: true, fromEnv: databaseUrlFile() }));
  assert.ok(rotation.error instanceof CliError, rotation.out);
  assert.equal(rotation.error.message, "Refusing to rotate secrets without --yes.");
  assert.match(rotation.out, /--force will ROTATE BETTER_AUTH_SECRET\./);
  assert.deepEqual(live.writes, []);
});

test("env:sync --target all: a key already set for Production is written only where it is missing", async () => {
  const vercel = fakeVercel(healthy());
  const { error, out } = await run(() => envSync(kitCli(), { target: "all", fromEnv: databaseUrlFile() }));
  assert.equal(error, undefined, out);
  assert.doesNotMatch(out, /ROTATE/, "filling in Preview and Development rotates nothing");
  const onProduction = new Set(healthy().map((e) => e.key));
  for (const write of vercel.writes) {
    assert.deepEqual(
      write.target,
      onProduction.has(write.key) ? ["preview", "development"] : ALL,
      `${write.key} keeps its Production value`,
    );
  }
  assert.ok(vercel.writes.some((w) => w.key === "BETTER_AUTH_SECRET"));
});

test("env:sync --target all or production,preview: an entry kept on Production is checked though the key is missing elsewhere", async () => {
  // The incident's storage, on Production only. The sync used to write the
  // issuer to Preview and Development, print "(preview, development only)"
  // and succeed, leaving the unreadable Production entry unmentioned.
  const sensitive = fakeVercel(replace(healthy(), raw("SSO_HANDOFF_ISSUER", "sensitive")));
  const all = await run(() => envSync(kitCli(), { target: "all", fromEnv: databaseUrlFile() }));
  assert.ok(all.error instanceof CliError, all.out);
  assert.equal(all.error.message, "1 variable(s) already set on Vercel fail the contract.");
  assert.match(
    all.out,
    /SSO_HANDOFF_ISSUER\s+production: public value stored write-only \(`sensitive`\), so it cannot be read back or verified/,
  );
  assert.deepEqual(sensitive.writes, [], "nothing is written when the sync refuses");

  const typo = fakeVercel(replace(healthy(), raw("SSO_HANDOFF_ISSUER", "plain", "httsp://demo.example.com")));
  const two = await run(() =>
    envSync(kitCli(), { target: "production,preview", fromEnv: databaseUrlFile() }),
  );
  assert.ok(two.error instanceof CliError, two.out);
  assert.match(two.out, /SSO_HANDOFF_ISSUER\s+production: "httsp:\/\/demo\.example\.com" must use/);
  assert.doesNotMatch(two.out, /\(preview only\)/, "no Plan is printed over a wrong kept entry");
  assert.deepEqual(typo.writes, []);
});

test("env:sync: a supplied value that differs from the one the recorded config pins is refused before it is written", async () => {
  // What `.env.example` ships, passed as --from-env. It passes the kit's
  // origin rule (loopback http), so it used to be written to Production,
  // and then the next sync and env:check both rejected it as WRONG.
  const listing = healthy().filter((e) => e.key !== "BETTER_AUTH_URL");
  const localhost = databaseUrlFile({ BETTER_AUTH_URL: "http://localhost:3000" });
  const refused = fakeVercel(listing);
  const { error, out } = await run(() => envSync(kitCli(), { fromEnv: localhost }));
  assert.ok(error instanceof CliError, out);
  assert.equal(error.message, "1 supplied value(s) differ from the recorded config.");
  assert.match(
    out,
    /BETTER_AUTH_URL\s+supplied "http:\/\/localhost:3000", but the recorded config derives "https:\/\/demo\.example\.com"/,
  );
  assert.match(out, /correct the recorded config with drk-deploy init/);
  assert.deepEqual(refused.writes, []);

  // Supplied equal to the derived value is no conflict.
  const same = fakeVercel(listing);
  const agreed = await run(() =>
    envSync(kitCli(), { fromEnv: databaseUrlFile({ BETTER_AUTH_URL: "https://demo.example.com" }) }),
  );
  assert.equal(agreed.error, undefined, agreed.out);
  assert.equal(same.writes.find((w) => w.key === "BETTER_AUTH_URL")?.value, "https://demo.example.com");

  // Development is where a localhost origin is right, and nothing checks its value there.
  const dev = fakeVercel(listing);
  const local = await run(() => envSync(kitCli(), { fromEnv: localhost, target: "development" }));
  assert.equal(local.error, undefined, local.out);
  assert.equal(dev.writes.find((w) => w.key === "BETTER_AUTH_URL")?.value, "http://localhost:3000");
});

test("env:sync: a supplied NEXT_PUBLIC_APP_NAME is written, and the next sync and env:check accept it", async () => {
  // The product name is derived only as a default: a different one is the
  // operator's choice, not a broken deployment. It used to be written, then
  // refused by the very next sync and by env:check, whose fix (remove it and
  // re-run env:sync) wrote it again.
  const vercel = fakeVercel(healthy(), undefined, true);
  const cliRoot = kitCli();
  const file = databaseUrlFile({ NEXT_PUBLIC_APP_NAME: "Acme Portal" });

  const first = await run(() => envSync(cliRoot, { fromEnv: file }));
  assert.equal(first.error, undefined, first.out);
  assert.equal(vercel.writes.find((w) => w.key === "NEXT_PUBLIC_APP_NAME")?.value, "Acme Portal");

  const second = await run(() => envSync(cliRoot, { fromEnv: file }));
  assert.equal(second.error, undefined, second.out);
  assert.match(second.out, /Nothing to do/);

  const check = await run(() => envCheck(cliRoot));
  assert.equal(check.result, 0, check.out);
  // Said as it is: readable, and no rule holds it to anything.
  assert.match(check.out, /NEXT_PUBLIC_APP_NAME\s+set production plain, readable, no rule\n/);
  assert.match(check.out, /SSO_HANDOFF_AUDIENCE_PREFIX\s+set production plain, value checked\n/);
});

/* ================================================================== */
/*  F-50: nothing sends anyone to prune the issuer's own keys          */
/* ================================================================== */

/** The kit's origin, and so the satellite's SSO issuer, in these fixtures. */
const ISSUER = "https://demo.example.com";

/** A CLI root configured for an Option A satellite on project prj_sat, with the kit as its issuer. */
function satelliteCli(database?: "own"): string {
  const cliRoot = join(workspace, `cli-${++fixtures}`);
  mkdirSync(cliRoot, { recursive: true });
  writeFileSync(
    join(cliRoot, ".drk-deploy.json"),
    JSON.stringify({
      ...KIT,
      projectId: "prj_sat",
      origin: "https://app1.example.net",
      applicationId: "standalone",
      kitRoot: join(cliRoot, "kit"),
      target: "satellite",
      satellite: {
        option: "standalone",
        appRoot: join(cliRoot, "app"),
        issuerOrigin: ISSUER,
        ...(database ? { database } : {}),
      },
    }),
  );
  return cliRoot;
}

/**
 * A fake Vercel API for project prj_sat: the project itself (with `aliases`
 * as its production aliases), its environment listing, and a record of every
 * write and removal. Anything else throws.
 */
function fakeSatelliteVercel(listing: ReturnType<typeof raw>[], aliases: string[]) {
  const writes: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.vercel.com") throw new Error(`an F-50 test reached ${url.hostname}`);
    if (request.method === "GET" && url.pathname === "/v9/projects/prj_sat") {
      return json({
        id: "prj_sat",
        name: "app-standalone",
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
      });
    }
    if (request.method === "GET" && url.pathname === "/v10/projects/prj_sat/env") {
      return json({ envs: listing, pagination: { count: listing.length, next: null, prev: null } });
    }
    if (request.method !== "GET") {
      writes.push(`${request.method} ${url.pathname}`);
      throw new Error(`an F-50 test wrote to Vercel: ${request.method} ${url.pathname}`);
    }
    throw new Error(`an F-50 test made an unexpected call: ${request.method} ${url.pathname}`);
  }) as typeof fetch;
  return { writes };
}

/** What the KIT's production holds, as a satellite config pointed at it would find it. */
function kitsProduction() {
  return [
    raw("BETTER_AUTH_URL", "plain", ISSUER),
    raw("SSO_HANDOFF_ISSUER", "plain", ISSUER),
    raw("SSO_HANDOFF_PRIVATE_KEY", "sensitive"),
    raw("SSO_HANDOFF_PREVIOUS_PRIVATE_KEY", "sensitive"),
    raw("SSO_ALLOWED_ORIGIN_SUFFIXES", "plain", "example.com,example.net"),
    raw("COOKIE_DOMAIN", "plain", ".example.com"),
    raw("SEED_ADMIN_PASSWORD", "encrypted", CIPHERTEXT),
  ];
}

const issuersProject = (evidence: RegExp) => (err: unknown) =>
  err instanceof CliError &&
  err.exitCode === 2 &&
  /^This satellite config points at the SSO issuer's own Vercel project: app-standalone \(prj_sat\) /.test(
    err.message,
  ) &&
  evidence.test(err.message) &&
  /No flag overrides this/.test(err.hint ?? "") &&
  !/env:prune/.test(`${err.message} ${err.hint}`);

test("F-50: env:prune refuses the issuer's project, so its signing key and origin allow-list are never removed", async () => {
  const byAlias = issuersProject(/serves demo\.example\.com, the SSO issuer's host/);
  for (const options of [{ yes: true }, { dryRun: true }, { yes: true, dryRun: true }]) {
    const vercel = fakeSatelliteVercel(kitsProduction(), ["demo.example.com", "kit.vercel.app"]);
    const { error, out } = await run(() => envPrune(satelliteCli(), options));
    assert.ok(byAlias(error), `${JSON.stringify(options)}: ${String(error)}\n${out}`);
    assert.deepEqual(vercel.writes, [], "nothing removed");
    // Not even listed as removable: a dry run used to present the issuer's
    // keys as a satellite's strays.
    assert.doesNotMatch(out, /^\s+SSO_HANDOFF_PRIVATE_KEY\s/m);
    assert.doesNotMatch(out, /^\s+SSO_ALLOWED_ORIGIN_SUFFIXES\s/m);
  }

  // A project whose aliases the API left out is still recognised, by the
  // origin its listing says it serves.
  fakeSatelliteVercel(kitsProduction(), []);
  const byListing = await run(() => envPrune(satelliteCli(), { yes: true }));
  assert.ok(
    issuersProject(/stores BETTER_AUTH_URL as https:\/\/demo\.example\.com, the SSO issuer's origin/)(
      byListing.error,
    ),
    `${String(byListing.error)}\n${byListing.out}`,
  );

  // On the satellite's own project it still finds a stray signing key.
  const own = fakeSatelliteVercel(
    [
      raw("BETTER_AUTH_URL", "plain", "https://app1.example.net"),
      raw("SSO_HANDOFF_PRIVATE_KEY", "sensitive"),
    ],
    ["app1.example.net"],
  );
  const stray = await run(() => envPrune(satelliteCli(), { dryRun: true }));
  assert.equal(stray.error, undefined, stray.out);
  assert.match(stray.out, /^\s+SSO_HANDOFF_PRIVATE_KEY\s+ISSUER ONLY/m);
  assert.match(stray.out, /--dry-run: nothing was removed/);
  assert.deepEqual(own.writes, []);

  // The kit's own prune list holds no issuer key: only the development-only
  // variables, whatever its project holds.
  fakeVercel([...healthy(), raw("SEED_ADMIN_PASSWORD", "encrypted", CIPHERTEXT)]);
  const kit = await run(() => envPrune(kitCli(), { dryRun: true }));
  assert.equal(kit.error, undefined, kit.out);
  assert.match(kit.out, /^\s+SEED_ADMIN_PASSWORD\s/m);
  assert.doesNotMatch(kit.out, /^\s+SSO_HANDOFF_PRIVATE_KEY\s/m);
  assert.doesNotMatch(kit.out, /^\s+SSO_ALLOWED_ORIGIN_SUFFIXES\s/m);
});

test("F-50: env:check, env:sync and db:provision refuse the issuer's project, and never point at env:prune there", async () => {
  const byAlias = issuersProject(/serves demo\.example\.com/);
  const commands: [string, (cliRoot: string) => Promise<unknown>][] = [
    ["env:check", (cliRoot) => envCheck(cliRoot)],
    ["env:sync", (cliRoot) => envSync(cliRoot, {})],
    ["env:sync --force --yes", (cliRoot) => envSync(cliRoot, { force: true, yes: true })],
  ];
  for (const [name, command] of commands) {
    const vercel = fakeSatelliteVercel(kitsProduction(), ["demo.example.com"]);
    const { error, out } = await run(() => command(satelliteCli()));
    assert.ok(byAlias(error), `${name}: ${String(error)}\n${out}`);
    assert.doesNotMatch(out, /env:prune/, `${name} says nothing about pruning`);
    assert.doesNotMatch(out, /Must NOT be set/, `${name} lists none of the issuer's keys as strays`);
    assert.deepEqual(vercel.writes, [], `${name} writes nothing`);
  }

  // A satellite that owns its database would connect a new store to the kit's project.
  const provision = fakeSatelliteVercel(kitsProduction(), ["demo.example.com"]);
  const store = await run(() => dbProvision(satelliteCli("own"), { dryRun: true }));
  assert.ok(byAlias(store.error), `${String(store.error)}\n${store.out}`);
  assert.deepEqual(provision.writes, []);

  // The kit's own check, with its signing key set, never mentions a prune.
  fakeVercel(healthy());
  const kit = await run(() => envCheck(kitCli()));
  assert.equal(kit.result, 0, kit.out);
  assert.doesNotMatch(kit.out, /env:prune/);
});

test("F-50: on a satellite's own project, every prune hint names the project it acts on", async () => {
  const listing = () => [
    raw("BETTER_AUTH_URL", "plain", "https://app1.example.net"),
    raw("SSO_HANDOFF_PRIVATE_KEY", "sensitive"),
  ];
  fakeSatelliteVercel(listing(), ["app1.example.net"]);
  const check = await run(() => envCheck(satelliteCli()));
  assert.ok((check.result as number) > 0, check.out);
  assert.match(check.out, /SSO_HANDOFF_PRIVATE_KEY\s+present — ISSUER ONLY/);
  assert.match(check.out, /Remove them from this satellite's project \(prj_sat\) with: drk-deploy env:prune/);

  const vercel = fakeSatelliteVercel(listing(), ["app1.example.net"]);
  const sync = await run(() => envSync(satelliteCli(), {}));
  assert.ok(sync.error instanceof CliError, sync.out);
  assert.equal(sync.error.message, "1 variable(s) must not exist on this deployment target.");
  assert.match(
    sync.error.hint ?? "",
    /^Remove them from this satellite's project \(prj_sat\) with `drk-deploy env:prune`/,
  );
  assert.deepEqual(vercel.writes, []);

  // And the post-deploy probe, which sees the key from the running app.
  const config = JSON.parse(readFileSync(join(satelliteCli(), ".drk-deploy.json"), "utf8"));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/sso/jwks.json") {
      return new Response(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "x" }] }), {
        status: 200,
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const verified = await run(() =>
    releaseRunner.verify(config, resolveProfile(config), { handoffSigning: null }),
  );
  assert.equal(verified.error, undefined, verified.out);
  // The consumer probes 404 here as well, so `healthy` alone would hold
  // without the key check. The key is its own problem: the issuer's stub
  // publishes the same `x`, so it is the kit's key.
  assert.equal(verified.result?.healthy, false, "a satellite publishing a key fails its probe (F-51)");
  assert.ok(
    verified.result?.problems.includes("it publishes the KIT's own SSO signing key"),
    `the key is a problem of its own (F-51): ${JSON.stringify(verified.result?.problems)}`,
  );
  assert.match(verified.out, /This satellite PUBLISHES 1 signing key\(s\)/);
  assert.match(
    verified.out,
    /Remove it from this satellite's project \(prj_sat\) with drk-deploy env:prune, then redeploy\./,
  );
});

test("F-50: under --config, the prune hints and the issuer refusal print commands that name that file", async () => {
  /** A satellite configured in its own file, selected as --config selects it. */
  const selected = (database?: "own") => {
    const cliRoot = satelliteCli(database);
    const file = join(cliRoot, ".drk-deploy.app-standalone.json");
    renameSync(join(cliRoot, ".drk-deploy.json"), file);
    useConfigFile(file);
    return { cliRoot, file };
  };
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = (file: string, command: string) =>
    new RegExp(escape(`drk-deploy --config "${file}" ${command}`));
  const listing = () => [
    raw("BETTER_AUTH_URL", "plain", "https://app1.example.net"),
    raw("SSO_HANDOFF_PRIVATE_KEY", "sensitive"),
  ];
  try {
    // Printed bare, each of these acted on the default file, which is the
    // KIT's in the layout the README recommends: a prune there removed
    // nothing of the satellite's, and an init re-pointed the kit's config.
    fakeSatelliteVercel(kitsProduction(), ["demo.example.com"]);
    const onKit = selected();
    const refused = await run(() => envPrune(onKit.cliRoot, { yes: true }));
    assert.ok(issuersProject(/serves demo\.example\.com/)(refused.error), String(refused.error));
    assert.match(
      (refused.error as CliError).hint ?? "",
      named(onKit.file, "init --project <its project> --domain <its host> --application-id <its id>"),
    );

    fakeSatelliteVercel(listing(), ["app1.example.net"]);
    const checked = selected();
    const check = await run(() => envCheck(checked.cliRoot));
    assert.ok((check.result as number) > 0, check.out);
    assert.match(check.out, named(checked.file, "env:prune"));

    const vercel = fakeSatelliteVercel(listing(), ["app1.example.net"]);
    const synced = selected();
    const sync = await run(() => envSync(synced.cliRoot, {}));
    assert.ok(sync.error instanceof CliError, sync.out);
    assert.match(sync.error.hint ?? "", named(synced.file, "env:prune"));
    assert.deepEqual(vercel.writes, []);

    // db:provision on a satellite that shares the kit's database names the
    // init that would record its own.
    const shared = selected();
    const provision = await run(() => dbProvision(shared.cliRoot, { dryRun: true }));
    assert.ok(provision.error instanceof CliError, provision.out);
    assert.match(provision.error.hint ?? "", named(shared.file, "init --own-database"));

    // And the post-deploy probe.
    const probed = selected();
    const config = JSON.parse(readFileSync(probed.file, "utf8"));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/sso/jwks.json") {
        return new Response(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "x" }] }), {
          status: 200,
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const verified = await run(() =>
      releaseRunner.verify(config, resolveProfile(config), { handoffSigning: null }),
    );
    assert.equal(verified.result?.healthy, false, verified.out);
    assert.match(verified.out, named(probed.file, "env:prune"));
  } finally {
    useConfigFile(null);
  }
});
