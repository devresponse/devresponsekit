/**
 * Shared safety rails for the OPERATIONAL database tools (`db:reset`,
 * `db:seed:dev`) — the scripts whose effect on the wrong database is either
 * irreversible (dropping the schema) or a credential leak (24 accounts with a
 * source-committed password, three of them cross-tenant superusers) — and for
 * the DB-backed test suite (`pnpm test:db`), which writes test users and
 * organizations into whatever database it is given (F-44).
 *
 * The rail is a HOST check on `DATABASE_URL`, not a `NODE_ENV` check:
 * `NODE_ENV` is a runtime convention of the Next server process and is
 * routinely unset in an operator's shell or a CI job whose `.env` carries a
 * production `DATABASE_URL`. Whatever the environment claims to be, a
 * connection string pointing at a non-local host is refused unless the caller
 * explicitly overrides it (review #19). Every tool shares this one
 * classification so the definition of "local" cannot drift between them.
 *
 * Like `schema-config.ts`, this module intentionally does NOT import
 * `server-only`: it must load from `tsx` scripts, from Vitest, and from
 * `vitest.db.config.ts` itself.
 */

/**
 * Hosts that resolve to the machine running the script. The empty string is
 * libpq's "no host given" (a local Unix socket / the default local server).
 * Compared after `normalizeHost` (lower-case, IPv6 brackets stripped).
 */
export const LOCAL_DB_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "",
]);

export interface DatabaseTarget {
  /** Normalized host name, or `"?"` when the URL could not be parsed. */
  host: string;
  /** Database name from the URL path, or `"?"`. */
  database: string;
  /** Whether `host` is one of {@link LOCAL_DB_HOSTS}. Fails CLOSED on a parse error. */
  local: boolean;
}

/**
 * Canonical form of a host for comparison: trimmed, lower-cased, and with the
 * `[...]` the WHATWG URL parser keeps around an IPv6 literal removed — so
 * `postgresql://u:p@[::1]:5432/db` is recognised as the loopback it is.
 */
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

/** Whether a (raw or normalized) host is a local one. */
export function isLocalDatabaseHost(host: string): boolean {
  return LOCAL_DB_HOSTS.has(normalizeHost(host));
}

/**
 * Parses a connection string into the host / database it targets and whether
 * that host is local. Anything the URL parser rejects (a libpq key=value
 * string, a multi-host URL, garbage) reports `host: "?"` and `local: false`,
 * so an unrecognisable target is treated as REMOTE — never as safe.
 */
export function describeDatabaseTarget(url: string): DatabaseTarget {
  try {
    const u = new URL(url);
    const host = normalizeHost(u.hostname);
    return {
      host,
      database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "?",
      local: isLocalDatabaseHost(host),
    };
  } catch {
    return { host: "?", database: "?", local: false };
  }
}

/** Thrown by {@link assertLocalDatabaseTarget} when a non-local host is refused. */
export class RemoteDatabaseRefusedError extends Error {
  readonly host: string;
  readonly database: string;

  constructor(message: string, target: DatabaseTarget) {
    super(message);
    this.name = "RemoteDatabaseRefusedError";
    this.host = target.host;
    this.database = target.database;
  }
}

export interface LocalTargetOptions {
  /** The caller's explicit override (`--force`, `DEV_SEED_ALLOW_REMOTE=1`, …). */
  allowRemote: boolean;
  /** Log prefix, e.g. `db:seed:dev`. */
  tool: string;
  /** One line saying what the tool would do to the remote database. */
  consequence: string;
  /** How to override, e.g. `re-run with --force`. */
  overrideHint: string;
}

/**
 * Returns the parsed target when its host is local OR the caller overrode the
 * check; otherwise throws {@link RemoteDatabaseRefusedError}. Call it BEFORE
 * constructing a pool so a refusal never opens a connection.
 */
export function assertLocalDatabaseTarget(
  url: string,
  options: LocalTargetOptions,
): DatabaseTarget {
  const target = describeDatabaseTarget(url);
  if (target.local || options.allowRemote) return target;
  throw new RemoteDatabaseRefusedError(
    `[${options.tool}] REFUSING: host "${target.host}" (database "${target.database}") is not local.\n` +
      `           ${options.consequence}\n` +
      `           If you really intend to target a remote database, ${options.overrideHint}.`,
    target,
  );
}

/**
 * The full pre-flight for the development fixture (`db:seed:dev`), evaluated
 * in this order and BEFORE any connection is opened:
 *
 *   1. `NODE_ENV=production` refuses unless `DEV_SEED_ALLOW_PROD=1` (the
 *      original guard, kept — it catches a mis-wired production process even
 *      when the host looks local, e.g. a sidecar Postgres).
 *   2. A non-local `DATABASE_URL` host refuses unless `DEV_SEED_ALLOW_REMOTE=1`
 *      or `--force` is given — independent of `NODE_ENV`.
 *
 * Returns the parsed target so the script can print where it is about to
 * write.
 */
export function assertDevSeedTarget(input: {
  databaseUrl: string;
  /** Defaults to `process.env`; injectable so the policy is testable without mutating it. */
  env?: Readonly<Record<string, string | undefined>>;
  argv?: readonly string[];
}): DatabaseTarget {
  const env: Readonly<Record<string, string | undefined>> = input.env ?? process.env;
  const argv = input.argv ?? process.argv;

  if (env.NODE_ENV === "production" && env.DEV_SEED_ALLOW_PROD !== "1") {
    throw new Error(
      "Refusing to run the development seed with NODE_ENV=production — it creates known-password " +
        "accounts. Set DEV_SEED_ALLOW_PROD=1 to override (not recommended).",
    );
  }

  const allowRemote = env.DEV_SEED_ALLOW_REMOTE === "1" || argv.includes("--force");
  return assertLocalDatabaseTarget(input.databaseUrl, {
    allowRemote,
    tool: "dev-init",
    consequence:
      "The development seed creates 24 known-password accounts (three of them cross-tenant superusers).",
    overrideHint: "re-run with --force or set DEV_SEED_ALLOW_REMOTE=1 (not recommended)",
  });
}

/** Which variable named the database `pnpm test:db` runs against. */
export type DbTestTargetSource = "DATABASE_TEST_URL" | "DATABASE_URL";

export interface DbTestTarget extends DatabaseTarget {
  /** The connection string the DB-backed suites receive as `DATABASE_URL`. */
  url: string;
  source: DbTestTargetSource;
}

/**
 * The pre-flight for `pnpm test:db` (F-44), run once by `vitest.db.config.ts`
 * when the config loads, before any worker starts, so a refusal opens no
 * connection:
 *
 *   1. `DATABASE_TEST_URL` names the database when it is set. The suites get
 *      it AS their `DATABASE_URL`, because that is the only variable the db
 *      layer reads (`src/db/schema-config.ts`). Before F-44 the config ignored
 *      it, so a developer who set it to a scratch database, as the docs said,
 *      still ran the suites against `.env`'s `DATABASE_URL`, hosted or not.
 *   2. Otherwise `DATABASE_URL`: the CI quality job's Postgres service, or a
 *      developer's local dev database. An empty value counts as unset (an
 *      `X=` line in `.env`).
 *   3. Whichever it is, a non-local host is refused unless
 *      `DB_TEST_ALLOW_REMOTE=1`. The suites create and delete users and
 *      organizations and briefly change the platform sign-up policy, which on
 *      a shared database would govern real sign-ups meanwhile. `CI` is no
 *      override: CI's database is on localhost, and a CI job whose environment
 *      carries a hosted `DATABASE_URL` is exactly the case to refuse.
 *
 * Neither variable set throws: the setup file's `DATABASE_URL ??=` default
 * names a database that does not exist, which would only fail later with a
 * connection error per suite.
 */
export function resolveDbTestTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DbTestTarget {
  const source: DbTestTargetSource | undefined = env.DATABASE_TEST_URL
    ? "DATABASE_TEST_URL"
    : env.DATABASE_URL
      ? "DATABASE_URL"
      : undefined;
  const url = source && env[source];
  if (!source || !url) {
    throw new Error(
      "[test:db] No database to run against: set DATABASE_TEST_URL to a local, migrated " +
        "Postgres database (docs/testing.md#the-db-backed-suites-database). DATABASE_URL is used only " +
        "when DATABASE_TEST_URL is unset.",
    );
  }
  const target = assertLocalDatabaseTarget(url, {
    allowRemote: env.DB_TEST_ALLOW_REMOTE === "1",
    tool: "test:db",
    consequence:
      `${source} names it, and the DB-backed suites create and delete users and organizations ` +
      "there and briefly change the platform sign-up policy.",
    overrideHint: "point it at a disposable database and set DB_TEST_ALLOW_REMOTE=1",
  });
  return { ...target, url, source };
}
