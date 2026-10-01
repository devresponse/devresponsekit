import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATE_WAIT_MS,
  GATE_POLL_MS,
  MAX_GATE_WAIT_MS,
  OWNER_WARNING,
  type AttemptResult,
  type LedgerRow,
  describeError,
  evaluateLedger,
  formatAttemptLine,
  formatFailLine,
  formatPassLine,
  formatPlanLine,
  formatTargetLine,
  formatVerifyLine,
  isConnectionError,
  parseGateWaitMs,
  planDeployGate,
  resolveHeadSha,
  runGateLoop,
} from "@/db/deploy-gate";
import { CONSOLIDATED_CORE_MIGRATIONS, migrationChecksum } from "@/db/migrations/migration-plan";

/**
 * The production build's schema gate, its pure half (DEP1): which builds it
 * verifies, how it reads a ledger, how long it polls, and every line it
 * prints. The database attempt and the script are covered against a live
 * Postgres by tests/db/deploy-gate.db.test.ts.
 */

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const PG = "postgres://app:pw@db.example.com/app";
const PGQL = "postgresql://app:pw@db.example.com:6543/app?sslmode=require";

/* ------------------------------------------------------------------ */
/*  planDeployGate                                                      */
/* ------------------------------------------------------------------ */

describe("planDeployGate: the whole matrix", () => {
  const vercelEnvs = ["production", "preview", "development", undefined] as const;
  const vercels = ["1", undefined] as const;
  const images = ["hive-build-image", undefined] as const;
  /** [label, token, headSha]: the token as the build sees it, and the commit being built. */
  const tokens: [string, string | undefined, string | null][] = [
    ["unset", undefined, HEAD],
    ["= headSha", HEAD, HEAD],
    ["= headSha, upper case", HEAD.toUpperCase(), HEAD],
    ["another sha", OTHER, HEAD],
    ["set, headSha unknown", HEAD, null],
  ];
  /** [raw, valid] */
  const waits: [string | undefined, boolean][] = [
    [undefined, true],
    ["", true],
    ["0", true],
    ["1800000", true],
    ["1800001", false],
    ["-1", false],
    ["abc", false],
    ["1e3", false],
  ];
  /** [raw, a usable postgres URL] */
  const urls: [string | undefined, boolean][] = [
    [undefined, false],
    ["", false],
    ["   ", false],
    ["[SENSITIVE]", false],
    ["httsp://x", false],
    [PG, true],
    [PGQL, true],
  ];

  /** The spec's decision table (docs/deployment.md §1.1), restated independently. */
  function expected(c: {
    vercelEnv: string | undefined;
    vercel: string | undefined;
    image: string | undefined;
    token: string | undefined;
    headSha: string | null;
    waitValid: boolean;
    urlValid: boolean;
  }): "skip" | "refuse" | "verify" {
    if (c.token !== undefined) {
      if (c.image !== undefined) return "refuse";
      return c.headSha !== null && c.token.toLowerCase() === c.headSha ? "skip" : "refuse";
    }
    if (c.vercelEnv === undefined) {
      return c.image !== undefined || c.vercel === "1" ? "refuse" : "skip";
    }
    if (c.vercelEnv !== "production") return "skip";
    if (!c.waitValid || !c.urlValid) return "refuse";
    return "verify";
  }

  const cases = vercelEnvs.flatMap((vercelEnv) =>
    vercels.flatMap((vercel) =>
      images.flatMap((image) =>
        tokens.flatMap(([tokenLabel, token, headSha]) =>
          waits.flatMap(([wait, waitValid]) =>
            urls.map(([url, urlValid]) => ({
              vercelEnv,
              vercel,
              image,
              tokenLabel,
              token,
              headSha,
              wait,
              waitValid,
              url,
              urlValid,
            })),
          ),
        ),
      ),
    ),
  );

  const planFor = (c: (typeof cases)[number]) =>
    planDeployGate(
      {
        VERCEL_ENV: c.vercelEnv,
        VERCEL: c.vercel,
        VERCEL_BUILD_IMAGE: c.image,
        DEPLOY_GATE_PREBUILT_AFTER_MIGRATE: c.token,
        DEPLOY_GATE_WAIT_MS: c.wait,
        DATABASE_URL: c.url,
      },
      c.headSha,
    );

  it(`decides every one of the ${cases.length} combinations as the decision table does`, () => {
    const wrong = cases
      .map((c) => ({ c, got: planFor(c).action, want: expected(c) }))
      .filter(({ got, want }) => got !== want)
      .map(({ c, got, want }) => `${JSON.stringify(c)}: ${got}, expected ${want}`);
    expect(wrong).toEqual([]);
  });

  it("never verifies a preview or development build, even with a DATABASE_URL", () => {
    for (const c of cases.filter(
      (x) => x.vercelEnv === "preview" || x.vercelEnv === "development",
    )) {
      expect(planFor(c).action).not.toBe("verify");
    }
  });

  it("refuses VERCEL=1 without VERCEL_ENV unless a valid token names the commit", () => {
    for (const c of cases.filter((x) => x.vercel === "1" && x.vercelEnv === undefined)) {
      const validToken =
        c.image === undefined && c.headSha !== null && c.token?.toLowerCase() === c.headSha;
      expect(planFor(c).action, JSON.stringify(c)).toBe(validToken ? "skip" : "refuse");
    }
  });

  it("skips on a valid token off Vercel's infrastructure, and refuses any token on it", () => {
    for (const c of cases.filter((x) => x.token !== undefined)) {
      const valid = c.headSha !== null && c.token!.toLowerCase() === c.headSha;
      const want = c.image !== undefined ? "refuse" : valid ? "skip" : "refuse";
      expect(planFor(c).action, JSON.stringify(c)).toBe(want);
    }
  });
});

describe("planDeployGate: reasons and the verify plan", () => {
  const production = { VERCEL_ENV: "production", DATABASE_URL: PGQL };

  it.each([
    [
      { ...production, VERCEL_BUILD_IMAGE: "img", DEPLOY_GATE_PREBUILT_AFTER_MIGRATE: HEAD },
      /not honoured on Vercel build infrastructure/,
    ],
    [
      { ...production, DEPLOY_GATE_PREBUILT_AFTER_MIGRATE: OTHER },
      /does not name the commit being built \(0123456789ab\)/,
    ],
    [
      { ...production, DEPLOY_GATE_PREBUILT_AFTER_MIGRATE: "main" },
      /does not name the commit being built/,
    ],
    [
      { VERCEL: "1" },
      /^VERCEL_ENV is missing on a Vercel build: enable Automatically expose System Environment Variables/,
    ],
    [{ VERCEL_BUILD_IMAGE: "img" }, /^VERCEL_ENV is missing/],
    [
      { ...production, DEPLOY_GATE_WAIT_MS: "10m" },
      /^DEPLOY_GATE_WAIT_MS must be a whole number of milliseconds from 0 to 1800000, got "10m"$/,
    ],
    [
      { VERCEL_ENV: "production" },
      /^DATABASE_URL is not set for this production build; the deployment could not serve$/,
    ],
    [
      { VERCEL_ENV: "production", DATABASE_URL: " [SENSITIVE] " },
      /unreadable placeholder from `vercel pull`; a local prebuilt build must pass DEPLOY_GATE_PREBUILT_AFTER_MIGRATE after migrating$/,
    ],
    [
      { VERCEL_ENV: "production", DATABASE_URL: "httsp://x" },
      /^DATABASE_URL is not a postgres:\/\/ or postgresql:\/\/ URL$/,
    ],
    [{ VERCEL_ENV: "production", DATABASE_URL: "not a url" }, /^DATABASE_URL is not a postgres/],
  ])("refuses %j", (env, reason) => {
    const plan = planDeployGate(env, HEAD);
    expect(plan.action).toBe("refuse");
    expect(plan.action === "refuse" && plan.reason).toMatch(reason);
  });

  it.each([
    [{}, "not-a-vercel-build"],
    [{ VERCEL_ENV: "preview", DATABASE_URL: PG }, "vercel-env=preview"],
    [{ VERCEL_ENV: " development " }, "vercel-env=development"],
    [
      { VERCEL: "1", DEPLOY_GATE_PREBUILT_AFTER_MIGRATE: ` ${HEAD.toUpperCase()} ` },
      "prebuilt-after-migrate",
    ],
  ])("skips %j", (env, reason) => {
    expect(planDeployGate(env, HEAD)).toEqual({ action: "skip", reason });
  });

  it("verifies a production build with what the script needs", () => {
    expect(planDeployGate({ ...production, DATABASE_URL: ` ${PGQL} ` }, HEAD)).toEqual({
      action: "verify",
      waitMs: DEFAULT_GATE_WAIT_MS,
      pollMs: GATE_POLL_MS,
      infra: "local",
      commit: HEAD,
      databaseUrl: PGQL,
    });
    expect(
      planDeployGate({ ...production, VERCEL_BUILD_IMAGE: "img", DEPLOY_GATE_WAIT_MS: "0" }, null),
    ).toMatchObject({ action: "verify", infra: "vercel", waitMs: 0, commit: null });
  });
});

describe("parseGateWaitMs and resolveHeadSha", () => {
  it("defaults, bounds and refuses", () => {
    expect(parseGateWaitMs(undefined)).toBe(600_000);
    expect(parseGateWaitMs("  ")).toBe(600_000);
    expect(parseGateWaitMs("0")).toBe(0);
    expect(parseGateWaitMs(" 90000 ")).toBe(90_000);
    expect(parseGateWaitMs(String(MAX_GATE_WAIT_MS))).toBe(1_800_000);
    for (const raw of ["1800001", "-1", "abc", "1e3", "1.5", "10m"]) {
      expect(parseGateWaitMs(raw), raw).toBeNull();
    }
  });

  it("prefers Vercel's commit, falls back to git, and is null when neither names one", () => {
    let asked = 0;
    const git = (value: string | null) => () => {
      asked++;
      return value;
    };
    expect(resolveHeadSha({ VERCEL_GIT_COMMIT_SHA: ` ${HEAD} ` }, git(OTHER))).toBe(HEAD);
    expect(asked).toBe(0);
    expect(resolveHeadSha({ VERCEL_GIT_COMMIT_SHA: "" }, git(`${OTHER}\n`))).toBe(OTHER);
    expect(resolveHeadSha({}, git(null))).toBeNull();
    expect(resolveHeadSha({}, git("  "))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  runGateLoop                                                         */
/* ------------------------------------------------------------------ */

/** A clock that only moves when the loop sleeps, or an attempt says it took time. */
function harness(script: Array<AttemptResult["status"]>, attemptMs = 0) {
  let t = 1_000_000;
  const slept: number[] = [];
  const lines: string[] = [];
  let calls = 0;
  const run = (waitMs: number, pollMs = GATE_POLL_MS) =>
    runGateLoop({
      attempt: async (n) => {
        calls++;
        expect(n).toBe(calls);
        t += attemptMs;
        const status = script[Math.min(n, script.length) - 1]!;
        return { status, reasons: [`reason ${n}`] };
      },
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
      waitMs,
      pollMs,
      log: (line) => lines.push(line),
    });
  return { run, slept, lines, calls: () => calls };
}

describe("runGateLoop", () => {
  it("passes on the first attempt without sleeping or logging", async () => {
    const h = harness(["ok"]);
    expect(await h.run(600_000)).toEqual({ outcome: "pass", attempts: 1, elapsedMs: 0 });
    expect(h.slept).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it("passes on attempt 3 after two behind, one poll apart", async () => {
    const h = harness(["behind", "behind", "ok"]);
    expect(await h.run(600_000)).toEqual({ outcome: "pass", attempts: 3, elapsedMs: 20_000 });
    expect(h.slept).toEqual([10_000, 10_000]);
    expect(h.lines).toEqual([
      "[deploy-gate] attempt 1 behind: reason 1",
      "[deploy-gate] attempt 2 behind: reason 2",
    ]);
  });

  it("fails behind at the deadline with the last reasons, the last attempt at the deadline", async () => {
    const h = harness(["behind"]);
    expect(await h.run(600_000)).toEqual({
      outcome: "fail",
      kind: "behind",
      reasons: ["reason 61"],
      attempts: 61,
      elapsedMs: 600_000,
    });
    expect(h.slept).toHaveLength(60);
  });

  it("stops at once on fatal, whatever time is left", async () => {
    const h = harness(["behind", "fatal", "ok"]);
    expect(await h.run(600_000)).toEqual({
      outcome: "fail",
      kind: "fatal",
      reasons: ["reason 2"],
      attempts: 2,
      elapsedMs: 10_000,
    });
    expect(h.lines).toEqual(["[deploy-gate] attempt 1 behind: reason 1"]);
  });

  it("retries an unreachable database, and reports unreachable when it never answers", async () => {
    const recovers = harness(["unreachable", "unreachable", "ok"]);
    expect(await recovers.run(600_000)).toMatchObject({ outcome: "pass", attempts: 3 });
    expect(recovers.lines[0]).toBe("[deploy-gate] attempt 1 unreachable: reason 1");
    const never = harness(["unreachable"]);
    expect(await never.run(30_000)).toMatchObject({
      outcome: "fail",
      kind: "unreachable",
      attempts: 4,
    });
  });

  it("makes exactly one attempt when waitMs is 0", async () => {
    const h = harness(["behind", "ok"]);
    expect(await h.run(0)).toMatchObject({ outcome: "fail", kind: "behind", attempts: 1 });
    expect(h.calls()).toBe(1);
    expect(h.slept).toEqual([]);
  });

  it("counts the time attempts take against the deadline", async () => {
    // 0→7s, sleep 10s, 17→24s; a third would start at 34s > 30s.
    const h = harness(["behind"], 7_000);
    expect(await h.run(30_000)).toMatchObject({ outcome: "fail", attempts: 2, elapsedMs: 24_000 });
  });
});

/* ------------------------------------------------------------------ */
/*  evaluateLedger                                                      */
/* ------------------------------------------------------------------ */

const MIGRATIONS = path.join(process.cwd(), "src/db/migrations");
const BASE = "0001-initial-schema.sql";
const RELEASE = "0002-release.sql";
const FILES = new Map(
  [BASE, RELEASE].map((id) => [id, readFileSync(path.join(MIGRATIONS, id), "utf8")]),
);
const sum = (id: string) => migrationChecksum(FILES.get(id)!);
const FOLDS = CONSOLIDATED_CORE_MIGRATIONS[RELEASE]!.folds;
const foldRows = (): LedgerRow[] => FOLDS.map((fold) => ({ id: fold.id, checksum: fold.checksum }));

describe("evaluateLedger", () => {
  it("is ok for a complete ledger at this build's checksums, extra ids included", () => {
    const rows: LedgerRow[] = [
      { id: BASE, checksum: sum(BASE) },
      { id: RELEASE, checksum: sum(RELEASE) },
      { id: "0003-from-a-newer-build.sql", checksum: "f".repeat(64) },
      { id: "locales/0000-email-templates-en.sql", checksum: null },
    ];
    expect(evaluateLedger(rows, FILES)).toEqual({ status: "ok", reasons: [], warnings: [] });
  });

  it("is behind, naming the id, when a required migration is missing", () => {
    expect(evaluateLedger([{ id: BASE, checksum: sum(BASE) }], FILES)).toEqual({
      status: "behind",
      reasons: [`the ledger lacks ${RELEASE}`],
      warnings: [],
    });
    expect(evaluateLedger([], FILES).reasons).toEqual([`the ledger lacks ${BASE}, ${RELEASE}`]);
  });

  it("counts a consolidated id as present when every fold is ledgered at its pin (MIG)", () => {
    expect(evaluateLedger([{ id: BASE, checksum: sum(BASE) }, ...foldRows()], FILES)).toEqual({
      status: "ok",
      reasons: [],
      warnings: [],
    });
    // Only some folds: behind on the consolidated id, and nothing compared.
    const partial = foldRows().slice(1);
    partial[0] = { ...partial[0]!, checksum: "0".repeat(64) };
    expect(evaluateLedger([{ id: BASE, checksum: sum(BASE) }, ...partial], FILES)).toMatchObject({
      status: "behind",
      reasons: [`the ledger lacks ${RELEASE}`],
    });
  });

  it("passes a row ledgered before review #86 (no checksum), with a warning", () => {
    const nullRelease = evaluateLedger(
      [
        { id: BASE, checksum: sum(BASE) },
        { id: RELEASE, checksum: null },
      ],
      FILES,
    );
    expect(nullRelease.status).toBe("ok");
    expect(nullRelease.warnings).toEqual([
      `${RELEASE} has no ledgered checksum (ledgered before review #86), so it was not compared with this build's file`,
    ]);
    const folds = foldRows();
    folds[2] = { ...folds[2]!, checksum: null };
    const nullFold = evaluateLedger([{ id: BASE, checksum: sum(BASE) }, ...folds], FILES);
    expect(nullFold.status).toBe("ok");
    expect(nullFold.warnings).toEqual([
      `${FOLDS[2]!.id} has no ledgered checksum (ledgered before review #86), so it was not compared with its section of ${RELEASE}`,
    ]);
  });

  it("is fatal on a different checksum, ahead of any gap", () => {
    const wrong = "a".repeat(64);
    const fatal = evaluateLedger([{ id: BASE, checksum: wrong }], FILES);
    expect(fatal.status).toBe("fatal");
    expect(fatal.reasons).toEqual([
      `the database holds a different version of ${BASE} than this build (ledger aaaaaaaaaaaa…, this build's file ${sum(BASE).slice(0, 12)}…)`,
    ]);
    const folds = foldRows();
    folds[4] = { ...folds[4]!, checksum: wrong };
    expect(evaluateLedger([{ id: BASE, checksum: sum(BASE) }, ...folds], FILES).reasons).toEqual([
      `the database holds a different version of ${FOLDS[4]!.id} than this build (ledger aaaaaaaaaaaa…, its section of ${RELEASE} ${FOLDS[4]!.checksum.slice(0, 12)}…)`,
    ]);
  });

  it("warns, and does not compare, when this build has no file for a ledgered id", () => {
    const rows = [
      { id: BASE, checksum: sum(BASE) },
      { id: RELEASE, checksum: "b".repeat(64) },
    ];
    expect(evaluateLedger(rows, new Map([[BASE, FILES.get(BASE)!]]))).toEqual({
      status: "ok",
      reasons: [],
      warnings: [`${RELEASE} is ledgered, but this build has no file for it to compare`],
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Errors                                                              */
/* ------------------------------------------------------------------ */

describe("isConnectionError and describeError", () => {
  it.each([
    [{ code: "08006", message: "connection failure" }, true],
    [{ code: "08P01", message: "unsupported startup parameter" }, true],
    [{ code: "57P03", message: "the database system is starting up" }, true],
    [{ code: "ECONNREFUSED" }, true],
    [{ code: "ENOTFOUND" }, true],
    [{ code: "ETIMEDOUT" }, true],
    [{ code: "ECONNRESET" }, true],
    [{ message: "Connection terminated due to connection timeout" }, true],
    [{ message: "timeout exceeded when trying to connect" }, true],
    [{ message: "Query read timeout" }, true],
    [Object.assign(new AggregateError([{ code: "ECONNREFUSED" }]), {}), true],
    [{ code: "28P01", message: "password authentication failed" }, false],
    [{ code: "42P01", message: "relation does not exist" }, false],
    [{ code: 8006 }, false],
    [new Error("something else"), false],
    ["ECONNREFUSED", false],
    [null, false],
  ])("%j → %s", (err, expected) => {
    expect(isConnectionError(err)).toBe(expected);
  });

  it("names the code and the message, and nothing else", () => {
    expect(describeError({ code: "57P03", message: "starting up " })).toBe("57P03 starting up");
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError({ code: "X", message: "" })).toBe("X no message");
    expect(describeError("plain")).toBe("plain");
  });
});

/* ------------------------------------------------------------------ */
/*  Output                                                              */
/* ------------------------------------------------------------------ */

describe("the lines the gate prints", () => {
  const NEON = "postgresql://u:p4ss-SECRET-zz@ep-a-pooler.x.neon.tech/neondb?sslmode=require";

  it("pins the target line DEP4 reads from the build log", () => {
    const line = formatTargetLine(NEON, "auth", "neondb_owner", true);
    expect(line).toBe(
      "[deploy-gate] target host=ep-a-pooler.x.neon.tech port=5432 database=neondb schema=auth user=neondb_owner runtime=owner",
    );
    expect(line).toMatch(
      /^\[deploy-gate\] target host=\S+ port=\d+ database=\S* schema=\S+ user=\S+ runtime=(?:owner|non-owner)$/,
    );
    for (const secret of ["p4ss-SECRET-zz", "sslmode", "postgresql://", "u:"]) {
      expect(line).not.toContain(secret);
    }
    // The database as the URL writes it: decoded, `my db` would split the
    // line's space-separated fields for whatever reads it back.
    const escaped = formatTargetLine(
      "postgres://app:pw@10.0.0.5:5444/my%20db",
      "tenant_a",
      "auth_runtime",
      false,
    );
    expect(escaped).toBe(
      "[deploy-gate] target host=10.0.0.5 port=5444 database=my%20db schema=tenant_a user=auth_runtime runtime=non-owner",
    );
    expect(escaped).toMatch(
      /^\[deploy-gate\] target host=\S+ port=\d+ database=\S* schema=\S+ user=\S+ runtime=(?:owner|non-owner)$/,
    );
    expect(formatTargetLine("postgres://app@h/bad%zzname", "auth", "app", false)).toContain(
      "database=bad%zzname ",
    );
  });

  it("prints the plan, attempt, PASS and FAIL lines in their documented form", () => {
    expect(formatPlanLine({ action: "skip", reason: "vercel-env=preview" })).toBe(
      "[deploy-gate] skip vercel-env=preview",
    );
    expect(formatPlanLine({ action: "refuse", reason: "why" })).toBe("[deploy-gate] REFUSE why");
    expect(
      formatVerifyLine({
        action: "verify",
        waitMs: 600_000,
        pollMs: GATE_POLL_MS,
        infra: "vercel",
        commit: HEAD,
        databaseUrl: NEON,
      }),
    ).toBe("[deploy-gate] verify env=production infra=vercel commit=0123456789ab wait=600s");
    expect(
      formatVerifyLine({
        action: "verify",
        waitMs: 1_500,
        pollMs: GATE_POLL_MS,
        infra: "local",
        commit: null,
        databaseUrl: NEON,
      }),
    ).toBe("[deploy-gate] verify env=production infra=local commit=unknown wait=1.5s");
    expect(formatAttemptLine(3, "unreachable", ["57P03 starting up", "b."])).toBe(
      "[deploy-gate] attempt 3 unreachable: 57P03 starting up; b",
    );
    expect(formatPassLine(12_345)).toBe("[deploy-gate] PASS schema current after 12.3s");
    expect(formatFailLine("behind", ["the ledger lacks 0003-x.sql."])).toBe(
      "[deploy-gate] FAIL behind: the ledger lacks 0003-x.sql. Production was not changed: Vercel does not promote a failed build. Apply the migrations against the DIRECT endpoint (docs/deployment.md §1.1), then redeploy this commit.",
    );
    expect(formatFailLine("timeout", [])).toMatch(
      /^\[deploy-gate\] FAIL timeout: no reason given\. /,
    );
    expect(OWNER_WARNING).toBe(
      "[deploy-gate] warning: the app connects as the table owner; the least-privilege login is not adopted (docs/deployment.md §8)",
    );
  });
});
