import {
  CONSOLIDATED_CORE_MIGRATIONS,
  REQUIRED_CORE_MIGRATIONS,
  migrationChecksum,
  missingCoreMigrations,
} from "./migrations/migration-plan";

/**
 * The production build's schema gate (DEP1): the pure half.
 *
 * Vercel's git integration builds and promotes every push to `main`, and
 * never migrates. Until DEP1 the only thing keeping a build
 * from going live ahead of its schema was a person remembering the hand gate
 * in docs/deployment.md §1.1, and forgetting it was an outage that
 * `/api/health/ready` could only report afterwards (review #43). Now every
 * Vercel production build runs `next build` and then `scripts/deploy-gate.ts`
 * (`vercel.json` → `pnpm run vercel-build`), which exits non-zero unless the
 * database holds every core migration this commit needs, at this commit's
 * checksums, and Better Auth's migrator has nothing to add. Vercel never
 * promotes a failed build, so the previous deployment keeps serving.
 *
 * This module decides everything that needs no database: whether this build
 * is one the gate verifies at all ({@link planDeployGate}), how a ledger
 * compares with this build ({@link evaluateLedger}), the retry loop
 * ({@link runGateLoop}) and every line the gate prints. No `pg`, no
 * `server-only`, no environment read at import, so all of it is unit-tested
 * under the coverage ratchet. The one database attempt is
 * `migrations/deploy-gate-check.ts`; the wiring is the script.
 *
 * The gate never writes. Migrations are applied by `migrate-production.yml`
 * on the same push (DEP2), or, as the fallback, by the hand gate or
 * `drk-deploy migrate`; the gate only refuses to let a build that needs them
 * go live without them, and polls for {@link DEFAULT_GATE_WAIT_MS} so a
 * migration started around the merge still lets the build through.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** How long a production build polls for its schema unless `DEPLOY_GATE_WAIT_MS` says otherwise. */
export const DEFAULT_GATE_WAIT_MS = 600_000;
/** The longest wait `DEPLOY_GATE_WAIT_MS` may ask for: 30 minutes, inside Vercel's build limit. */
export const MAX_GATE_WAIT_MS = 1_800_000;
/** The pause between two attempts. */
export const GATE_POLL_MS = 10_000;
/** What `vercel pull` writes for a variable stored `sensitive`: nothing to connect with. */
export const SENSITIVE_PLACEHOLDER = "[SENSITIVE]";

/** A git commit id as `git rev-parse HEAD` prints it. */
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

/** What the gate does for this build (DEP1, docs/deployment.md §1.1). */
export type GatePlan =
  /** Not a build the gate verifies; exit 0 without connecting. */
  | { action: "skip"; reason: string }
  /** A build the gate cannot verify and must not let through; exit 1 without connecting. */
  | { action: "refuse"; reason: string }
  /** A production build: connect with its own DATABASE_URL and poll for the schema. */
  | {
      action: "verify";
      waitMs: number;
      pollMs: number;
      /** `vercel` on Vercel's build machines, `local` for a `vercel build` elsewhere. */
      infra: "vercel" | "local";
      /** The commit being built, or null when it cannot be named. */
      commit: string | null;
      /** The build's DATABASE_URL, trimmed: only its host, port and database are ever printed. */
      databaseUrl: string;
    };

/**
 * The commit being built: Vercel's `VERCEL_GIT_COMMIT_SHA` when it is set,
 * else what `readGitHead` (the script's `git rev-parse HEAD`) returns, else
 * null. A local `vercel build` pulls the system variables empty, so the
 * checkout's own HEAD names the commit there.
 */
export function resolveHeadSha(env: Env, readGitHead: () => string | null): string | null {
  const fromVercel = (env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  if (fromVercel) return fromVercel;
  const fromGit = readGitHead()?.trim();
  return fromGit ? fromGit : null;
}

/**
 * `DEPLOY_GATE_WAIT_MS`: unset or empty is {@link DEFAULT_GATE_WAIT_MS}, a
 * whole number of milliseconds up to {@link MAX_GATE_WAIT_MS} is itself (`0`
 * is exactly one attempt), and anything else is null, which refuses the build
 * rather than guessing what `10m` or `1e3` meant.
 */
export function parseGateWaitMs(raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_GATE_WAIT_MS;
  if (!/^\d+$/.test(value)) return null;
  const ms = Number(value);
  return ms <= MAX_GATE_WAIT_MS ? ms : null;
}

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

/**
 * Decides, from the build's environment alone, what the gate does. In order:
 *
 *   1. `DEPLOY_GATE_PREBUILT_AFTER_MIGRATE` set: drk-deploy migrates and then
 *      runs `vercel build --prod` on its own machine, where a sensitive
 *      DATABASE_URL comes back as {@link SENSITIVE_PLACEHOLDER} and cannot be
 *      checked. It passes the commit it migrated from. It is
 *      refused on Vercel's build machines whatever its value, so a copy left
 *      in the project's environment can never switch the gate off there, and
 *      honoured elsewhere only when it is exactly the commit being built
 *      (40 hex characters, any case), which a left-over value never is for
 *      long. There is deliberately no other bypass: break-glass is reverting
 *      the commit that added the gate.
 *   2. No `VERCEL_ENV`: refused when this is a Vercel build anyway
 *      (`VERCEL_BUILD_IMAGE` is the Vercel CLI's own test for its build
 *      machines, and `vercel build` sets `VERCEL=1` everywhere), because
 *      without the system variables the gate cannot tell production from a
 *      preview. Otherwise it is a plain `pnpm run vercel-build`: skipped.
 *   3. Any environment but production: skipped, without connecting, even
 *      when a DATABASE_URL is present. Kit previews have no database.
 *   4. Production: `DEPLOY_GATE_WAIT_MS` must parse, and DATABASE_URL must be
 *      a readable postgres URL, or the build is refused (a production build
 *      without one could not serve anyway). Then the gate verifies.
 *
 * Neither `skip` nor `refuse` opens a pool or imports the auth module.
 */
export function planDeployGate(env: Env, headSha: string | null): GatePlan {
  const read = (name: string) => (env[name] ?? "").trim();
  const onVercelInfra = read("VERCEL_BUILD_IMAGE") !== "";

  const token = read("DEPLOY_GATE_PREBUILT_AFTER_MIGRATE");
  if (token) {
    if (onVercelInfra) {
      return {
        action: "refuse",
        reason:
          "DEPLOY_GATE_PREBUILT_AFTER_MIGRATE is not honoured on Vercel build infrastructure: delete it from the project's environment variables",
      };
    }
    const names = COMMIT_SHA.test(token) && headSha?.toLowerCase() === token.toLowerCase();
    if (!names) {
      return {
        action: "refuse",
        reason: `DEPLOY_GATE_PREBUILT_AFTER_MIGRATE does not name the commit being built (${shortCommit(headSha)}): pass the commit that was migrated, and only after migrating it`,
      };
    }
    return { action: "skip", reason: "prebuilt-after-migrate" };
  }

  const vercelEnv = read("VERCEL_ENV");
  if (!vercelEnv) {
    if (onVercelInfra || read("VERCEL") === "1") {
      return {
        action: "refuse",
        reason:
          "VERCEL_ENV is missing on a Vercel build: enable Automatically expose System Environment Variables (Project → Settings → Environment Variables)",
      };
    }
    return { action: "skip", reason: "not-a-vercel-build" };
  }
  if (vercelEnv !== "production") return { action: "skip", reason: `vercel-env=${vercelEnv}` };

  const waitMs = parseGateWaitMs(env.DEPLOY_GATE_WAIT_MS);
  if (waitMs === null) {
    return {
      action: "refuse",
      reason: `DEPLOY_GATE_WAIT_MS must be a whole number of milliseconds from 0 to ${MAX_GATE_WAIT_MS}, got "${read("DEPLOY_GATE_WAIT_MS")}"`,
    };
  }
  const databaseUrl = read("DATABASE_URL");
  if (!databaseUrl) {
    return {
      action: "refuse",
      reason: "DATABASE_URL is not set for this production build; the deployment could not serve",
    };
  }
  if (databaseUrl === SENSITIVE_PLACEHOLDER) {
    return {
      action: "refuse",
      reason: `DATABASE_URL is ${SENSITIVE_PLACEHOLDER}, the unreadable placeholder from \`vercel pull\`; a local prebuilt build must pass DEPLOY_GATE_PREBUILT_AFTER_MIGRATE after migrating`,
    };
  }
  if (!isPostgresUrl(databaseUrl)) {
    return {
      action: "refuse",
      reason: "DATABASE_URL is not a postgres:// or postgresql:// URL",
    };
  }
  return {
    action: "verify",
    waitMs,
    pollMs: GATE_POLL_MS,
    infra: onVercelInfra ? "vercel" : "local",
    commit: headSha,
    databaseUrl,
  };
}

/* ------------------------------------------------------------------ */
/*  The ledger, as this build sees it                                   */
/* ------------------------------------------------------------------ */

/** One `app_schema_migrations` row. */
export interface LedgerRow {
  id: string;
  checksum: string | null;
}

/** What {@link evaluateLedger} found. */
export interface LedgerVerdict {
  status: "ok" | "behind" | "fatal";
  reasons: string[];
  /** Said once, never a reason to fail. */
  warnings: string[];
}

const shortHash = (hash: string) => `${hash.slice(0, 12)}…`;

/**
 * Compares the ledger with this build (DEP1).
 *
 * - Every id in `REQUIRED_CORE_MIGRATIONS` must be present, a consolidated
 *   one counting as present when every id it folds is (`missingCoreMigrations`,
 *   MIG). Otherwise `behind`, naming the ids: waiting can fix that.
 * - A required id that is ledgered, with its file in `filesById`, must be
 *   ledgered under this build's checksum of that file. A consolidated id met
 *   by its folds is compared fold by fold with the pins in
 *   `CONSOLIDATED_CORE_MIGRATIONS`. A different checksum is `fatal`: the
 *   database applied another version of that file than this build carries,
 *   which no amount of waiting changes. A row with no checksum (ledgered
 *   before review #86) passes, with a warning, as it does for the runner.
 * - Ids the build does not know (the database is ahead of the build, as after
 *   an Instant Rollback) are fine.
 *
 * A mismatch wins over a gap, so a build that can never pass stops at once.
 */
export function evaluateLedger(
  rows: readonly LedgerRow[],
  filesById: ReadonlyMap<string, string>,
): LedgerVerdict {
  const ledger = new Map(rows.map((row) => [row.id, row.checksum]));
  const fatal: string[] = [];
  const warnings: string[] = [];
  const compare = (id: string, expected: string, what: string) => {
    const stored = ledger.get(id) ?? null;
    if (stored === null) {
      warnings.push(
        `${id} has no ledgered checksum (ledgered before review #86), so it was not compared with ${what}`,
      );
    } else if (stored !== expected) {
      fatal.push(
        `the database holds a different version of ${id} than this build (ledger ${shortHash(stored)}, ${what} ${shortHash(expected)})`,
      );
    }
  };

  for (const id of REQUIRED_CORE_MIGRATIONS) {
    if (ledger.has(id)) {
      const text = filesById.get(id);
      if (text === undefined) {
        warnings.push(`${id} is ledgered, but this build has no file for it to compare`);
      } else {
        compare(id, migrationChecksum(text), "this build's file");
      }
      continue;
    }
    const folds = CONSOLIDATED_CORE_MIGRATIONS[id]?.folds;
    if (folds?.every((fold) => ledger.has(fold.id))) {
      for (const fold of folds) compare(fold.id, fold.checksum, `its section of ${id}`);
    }
  }

  if (fatal.length > 0) return { status: "fatal", reasons: fatal, warnings };
  const missing = missingCoreMigrations(ledger.keys());
  if (missing.length > 0) {
    return { status: "behind", reasons: [`the ledger lacks ${missing.join(", ")}`], warnings };
  }
  return { status: "ok", reasons: [], warnings };
}

/* ------------------------------------------------------------------ */
/*  Errors                                                              */
/* ------------------------------------------------------------------ */

/** Socket-level failures that a cold start or a network blip produces, and a retry can outlast. */
const CONNECTION_ERRNOS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/**
 * pg's own connection failures, which carry no code: a connect that exceeded
 * `connectionTimeoutMillis`, a server that hung up, a query past `query_timeout`.
 */
const PG_CONNECTION_MESSAGE =
  /^(?:Connection terminated|timeout exceeded when trying to connect)|Query read timeout/i;

/**
 * Whether `err` means the database could not be reached, rather than that it
 * answered: SQLSTATE class 08 (connection exception) or 57P03 (cannot connect
 * now: Neon's compute still starting), a connection-class errno, pg's
 * connection timeouts, or an AggregateError of those (Node tries each address
 * of a host). The gate retries these until its deadline; anything else the
 * database says is final.
 */
export function isConnectionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message, errors } = err as { code?: unknown; message?: unknown; errors?: unknown };
  if (typeof code === "string") {
    if (code.startsWith("08") || code === "57P03" || CONNECTION_ERRNOS.has(code)) return true;
  }
  if (Array.isArray(errors) && errors.some(isConnectionError)) return true;
  return typeof message === "string" && PG_CONNECTION_MESSAGE.test(message);
}

/**
 * One line for an error: its code and message. Neither pg nor Node puts a
 * connection string in either, so nothing secret is printed.
 */
export function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    const text = typeof message === "string" && message.trim() ? message.trim() : "no message";
    return typeof code === "string" && code ? `${code} ${text}` : text;
  }
  return String(err);
}

/* ------------------------------------------------------------------ */
/*  The loop                                                            */
/* ------------------------------------------------------------------ */

/** The outcome of one attempt (`checkDatabase`). */
export interface AttemptResult {
  status: "ok" | "behind" | "unreachable" | "fatal";
  reasons: readonly string[];
}

export interface GateLoopOptions {
  /** One check of the database; `n` counts from 1. */
  attempt: (n: number) => Promise<AttemptResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitMs: number;
  pollMs: number;
  log: (line: string) => void;
}

export type GateOutcome =
  | { outcome: "pass"; attempts: number; elapsedMs: number }
  | {
      outcome: "fail";
      kind: "behind" | "unreachable" | "fatal";
      reasons: readonly string[];
      attempts: number;
      elapsedMs: number;
    };

/**
 * Polls until the schema is current or the wait is over: the first attempt at
 * once, then one every `pollMs` while the next would still start within
 * `waitMs` (`0` is exactly one attempt). `ok` passes; `fatal` fails at once;
 * `behind` and `unreachable` are logged and retried, and the last one's
 * reasons are the failure at the deadline. The clock and the sleep are
 * injected so the schedule is tested without waiting.
 */
export async function runGateLoop(options: GateLoopOptions): Promise<GateOutcome> {
  const { attempt, now, sleep, waitMs, pollMs, log } = options;
  const start = now();
  for (let n = 1; ; n++) {
    const result = await attempt(n);
    const elapsedMs = now() - start;
    if (result.status === "ok") return { outcome: "pass", attempts: n, elapsedMs };
    if (result.status === "fatal") {
      return { outcome: "fail", kind: "fatal", reasons: result.reasons, attempts: n, elapsedMs };
    }
    log(formatAttemptLine(n, result.status, result.reasons));
    if (waitMs === 0 || elapsedMs + pollMs > waitMs) {
      return {
        outcome: "fail",
        kind: result.status,
        reasons: result.reasons,
        attempts: n,
        elapsedMs,
      };
    }
    await sleep(pollMs);
  }
}

/* ------------------------------------------------------------------ */
/*  Output: one line each, on stdout (docs/troubleshooting.md)          */
/* ------------------------------------------------------------------ */

export const GATE_PREFIX = "[deploy-gate]";

/** Printed when the app connects as the ledger's owner (or a superuser). */
export const OWNER_WARNING = `${GATE_PREFIX} warning: the app connects as the table owner; the least-privilege login is not adopted (docs/deployment.md §8)`;

const shortCommit = (commit: string | null) => (commit ? commit.slice(0, 12) : "unknown");
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
/** Reasons joined into one clause, without a trailing full stop to double up. */
const joined = (reasons: readonly string[]) =>
  reasons.map((reason) => reason.replace(/\.+$/, "")).join("; ") || "no reason given";

/** `[deploy-gate] skip <reason>` or `[deploy-gate] REFUSE <reason>`. */
export function formatPlanLine(plan: Extract<GatePlan, { action: "skip" | "refuse" }>): string {
  return `${GATE_PREFIX} ${plan.action === "skip" ? "skip" : "REFUSE"} ${plan.reason}`;
}

/** `[deploy-gate] verify env=production infra=<vercel|local> commit=<12> wait=<s>s`. */
export function formatVerifyLine(plan: Extract<GatePlan, { action: "verify" }>): string {
  return `${GATE_PREFIX} verify env=production infra=${plan.infra} commit=${shortCommit(plan.commit)} wait=${seconds(plan.waitMs)}`;
}

/**
 * `[deploy-gate] target host=… port=… database=… schema=… user=… runtime=…`.
 *
 * The format is a contract: DEP4's operator command reads this exact line from
 * the production build log as its reference for which database production
 * uses, so tests/unit/deploy-gate.test.ts pins it. Host, port and database
 * come from the URL and are not secret (drk-deploy's `redactUrl` prints them
 * too); the user is the one the database reports. The password, the query
 * string and the URL itself are never printed. The database is printed as
 * the URL writes it, percent-escapes and all: decoded, a name with a space
 * in it would split the line's space-separated fields.
 */
export function formatTargetLine(
  url: string,
  schema: string,
  currentUser: string,
  isOwner: boolean,
): string {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, "");
  return `${GATE_PREFIX} target host=${parsed.hostname} port=${parsed.port || "5432"} database=${database} schema=${schema} user=${currentUser} runtime=${isOwner ? "owner" : "non-owner"}`;
}

/** `[deploy-gate] attempt <n> <behind|unreachable>: <reasons>`. */
export function formatAttemptLine(
  n: number,
  kind: "behind" | "unreachable",
  reasons: readonly string[],
): string {
  return `${GATE_PREFIX} attempt ${n} ${kind}: ${joined(reasons)}`;
}

/** `[deploy-gate] PASS schema current after <s>s`. */
export function formatPassLine(elapsedMs: number): string {
  return `${GATE_PREFIX} PASS schema current after ${seconds(elapsedMs)}`;
}

/** The last line of a failed gate, with what production is doing and what to do next. */
export function formatFailLine(
  kind: "behind" | "fatal" | "unreachable" | "timeout",
  reasons: readonly string[],
): string {
  return (
    `${GATE_PREFIX} FAIL ${kind}: ${joined(reasons)}. Production was not changed: Vercel does not ` +
    "promote a failed build. Apply the migrations against the DIRECT endpoint " +
    "(docs/deployment.md §1.1), then redeploy this commit."
  );
}
