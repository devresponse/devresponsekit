import { CliError } from "./log.js";

/**
 * Which database and which schema a migration is about to change, and whether
 * they are production's (F-47).
 *
 * `drk-deploy` migrates and then promotes. If the migration lands anywhere but
 * the database the promoted build reads, the promotion puts a build that
 * expects the new schema in front of a database without it: every check this
 * CLI runs before the promotion is green, and `/api/health/ready` answers 503
 * `schema_behind` after it. The target used to be whatever the shell's
 * `DATABASE_URL` said, which on a developer machine is a local database, and
 * nothing compared it with production. So the URL must now be named
 * explicitly (see `resolveMigrationUrl`), and before anything is migrated it
 * is compared with what production itself reads, pulled read-only with
 * `vercel pull`. Pure, so every rule below is table-tested.
 */

/**
 * What the pinned Vercel CLI (59.x) writes into the pulled file for a value it
 * may not read, which is one stored `sensitive`. Such a value is not
 * production's URL, so it can never match or mismatch anything.
 */
export const SENSITIVE_PLACEHOLDER = "[SENSITIVE]";

/**
 * The production variables a migration URL may match. `DATABASE_URL` is what
 * the app reads. Neon's integration also injects `DATABASE_URL_UNPOOLED`, the
 * direct twin of the same database, which is the one to store (encrypted, so
 * it can be read back) when `DATABASE_URL` is `sensitive` or its pooled host
 * is not Neon's `-pooler` form of the direct one.
 */
export const REFERENCE_KEYS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;

/** The schema the kit and every satellite use when `DB_SCHEMA` is not set. */
export const DEFAULT_SCHEMA = "auth";

/** Hides credentials in a connection string before it is printed. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username}:***@` : "";
    return `${parsed.protocol}//${user}${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
}

/** A `postgres://` or `postgresql://` URL, or null for anything else. */
export function parsePostgresUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Why a connection string looks POOLED, or null when it does not.
 *
 * The check used to be a single `-pooler.` substring, which is Neon's form
 * only. Supabase's pooler is a `.pooler.` host on port 6543, and PgBouncer
 * setups are marked with `pgbouncer=true` (F-47). Every one of them breaks
 * the same way: DDL and the runner's advisory lock do not survive a
 * transaction pooler, and the failure is quiet.
 */
export function pooledReason(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (/-pooler(\.|$)/.test(host)) return "its host carries Neon's `-pooler` suffix";
  if (/(^|\.)pooler\./.test(host)) return "its host is a `.pooler.` endpoint";
  if (url.port === "6543") return "it uses port 6543, the transaction pooler's port";
  if (url.searchParams.get("pgbouncer")?.toLowerCase() === "true") return "it carries `pgbouncer=true`";
  return null;
}

/**
 * Query parameters that send a connection somewhere other than the URL's own
 * host, port, database or user. `pg` honours `?host=`, `?port=` and `?user=`
 * over the URL's authority, and libpq reads `hostaddr` and `dbname` as well.
 * The target check compares the authority, so a migration URL carrying one
 * would be checked as one database and migrate another. It is refused, not
 * interpreted: what each driver makes of them differs.
 */
const REPOINTING_PARAMS = ["host", "hostaddr", "port", "dbname", "database", "user"] as const;

/** The query parameters in `url` that re-point its connection, in {@link REPOINTING_PARAMS} order. */
export function repointingParams(url: URL): string[] {
  return REPOINTING_PARAMS.filter((name) => url.searchParams.has(name));
}

/** The refusal for a URL {@link repointingParams} flags. Names the parameters, never the URL. */
export function repointedError(params: readonly string[], exitCode?: number): CliError {
  return new CliError(
    `The migration URL re-points the connection with ${params.map((p) => `\`${p}\``).join(", ")} in its query.`,
    {
      ...(exitCode !== undefined ? { exitCode } : {}),
      hint: "The URL is checked against production by its own host, port, database and user, so it must say all of them there: postgresql://user:password@host:port/database. Drop these parameters.",
    },
  );
}

/**
 * Supabase's shared pooler (Supavisor): one host per region, serving EVERY
 * project in it, each with a database called `postgres`. Host and database
 * name say nothing about which project a URL reaches there. The project ref
 * rides in the username instead, `postgres.<ref>`.
 */
const SHARED_POOLER_HOST = /(^|\.)pooler\.supabase\.com$/;

/** The port a URL that names none connects to (the runner is handed no PGPORT: see `migrationEnv`). */
const DEFAULT_PORT = "5432";

/** The database a connection string reaches. Compare two with {@link sameDatabase}. */
export interface DatabaseIdentity {
  host: string;
  /** The port, 5432 when the URL names none. Null on a shared pooler, where it picks a pooling mode, not a server. */
  port: string | null;
  database: string;
  /** On a shared pooler, the project the username routes to ("" when it names none). Null elsewhere. */
  tenant: string | null;
}

/**
 * Host, port and database, normalized so a pooled and a direct URL for the
 * SAME Neon database compare equal: `ep-x-pooler.region.aws.neon.tech` is
 * `ep-x.region.aws.neon.tech` behind the pooler, on the same port. Hosts are
 * case-insensitive (a `postgres:` URL keeps the case it was written in);
 * database names are not. No database in the path means libpq's default,
 * the user's own name.
 *
 * The port counts: two clusters on one host with the same database name are
 * two databases. A pooler on its own port in front of the direct server
 * (PgBouncer on 6432, Supabase's dedicated pooler on 6543) therefore does not
 * match the direct URL; store that as `DATABASE_URL_UNPOOLED`. On Supabase's
 * SHARED pooler the project in the username is compared instead of the port:
 * 5432 (session mode) and 6543 (transaction mode) reach the same project,
 * and every project in the region shares the host and database.
 */
export function databaseIdentity(url: URL): DatabaseIdentity {
  const [first = "", ...rest] = url.hostname.toLowerCase().split(".");
  const host = [first.replace(/-pooler$/, ""), ...rest].join(".");
  const user = safeDecode(url.username);
  const database = safeDecode(url.pathname.replace(/^\//, "")) || user;
  if (SHARED_POOLER_HOST.test(host)) {
    const dot = user.indexOf(".");
    return { host, port: null, database, tenant: dot === -1 ? "" : user.slice(dot + 1) };
  }
  return { host, port: url.port || DEFAULT_PORT, database, tenant: null };
}

/**
 * Whether two identities are one database. A shared-pooler URL whose username
 * names no project matches nothing: it names no database.
 */
export function sameDatabase(a: DatabaseIdentity, b: DatabaseIdentity): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.database === b.database &&
    a.tenant === b.tenant &&
    a.tenant !== ""
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A value `vercel pull` actually delivered: present, non-empty, not redacted. */
function readable(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === SENSITIVE_PLACEHOLDER ? null : trimmed;
}

export interface TargetCheckInput {
  /** The migration URL, already resolved from an explicit source. */
  url: string;
  /** Production's variables, as `vercel pull --environment=production` wrote them. */
  production: Readonly<Record<string, string>>;
  /** `--schema`, when the operator gave one. */
  schema?: string | undefined;
  /** Proceed when production's values cannot be READ. Never covers a mismatch. */
  allowUnverifiedTarget?: boolean | undefined;
  /** Migrate an explicit `--schema` that production does not read. */
  forceSchema?: boolean | undefined;
}

export interface MigrationTarget {
  /** The schema to migrate. */
  schema: string;
  /** Where that schema came from, in words. */
  schemaReason: string;
  /** The production variable the URL matched, or null when the check was overridden. */
  matched: { key: string; url: string } | null;
  /** One line per check an override skipped, printed as a warning. */
  overrides: string[];
}

/**
 * Refuses a migration target that is not production's, before anything is
 * migrated.
 *
 * The database: host (Neon's `-pooler` removed), port and database name (on
 * Supabase's shared pooler, the project in the username rather than the port:
 * see {@link databaseIdentity}) must equal those of production's
 * `DATABASE_URL` or `DATABASE_URL_UNPOOLED`. A mismatch has no override: the
 * fix is the right URL, or a readable `DATABASE_URL_UNPOOLED` when
 * production's pooled URL is genuinely not the direct one. A migration URL
 * whose query re-points the connection (`?host=`, ...) is refused outright.
 * `--allow-unverified-target` covers only the case where neither
 * value could be read, because a value stored `sensitive` comes back as a
 * placeholder and there is nothing to compare.
 *
 * The schema: production's `DB_SCHEMA` (or `auth` when production sets none)
 * is the default, so a production running `tenant_a` is no longer migrated in
 * `auth`. An explicit `--schema` that differs is refused unless
 * `--force-schema`. When production's `DB_SCHEMA` cannot be read, the schema
 * is never guessed: `--schema` is required, with `--allow-unverified-target`.
 */
export function verifyMigrationTarget(input: TargetCheckInput): MigrationTarget {
  const parsed = parsePostgresUrl(input.url);
  if (!parsed) {
    throw new CliError("The migration URL is not a postgres:// connection string.", { exitCode: 2 });
  }
  // `resolveMigrationUrl` refuses these first; repeated here so the check
  // never vouches for an authority the connection will not use.
  const repointed = repointingParams(parsed);
  if (repointed.length > 0) throw repointedError(repointed, 2);
  const mine = databaseIdentity(parsed);
  const overrides: string[] = [];

  const references = REFERENCE_KEYS.flatMap((key) => {
    const value = readable(input.production[key]);
    const url = value === null ? null : parsePostgresUrl(value);
    return value !== null && url !== null && url.hostname !== ""
      ? [{ key, url: value, identity: databaseIdentity(url) }]
      : [];
  });
  const hit = references.find((ref) => sameDatabase(ref.identity, mine));

  if (!hit && references.length > 0) {
    throw new CliError("Refusing to migrate: the migration URL is not production's database.", {
      exitCode: 2,
      hint: [
        `migrating: ${redactUrl(input.url)}`,
        ...references.map((ref) => `production ${ref.key}: ${redactUrl(ref.url)}`),
        "The host (with Neon's `-pooler` removed), the port (5432 when none is given) and the database name",
        "must match one of production's. On Supabase's shared pooler (`*.pooler.supabase.com`), every project",
        "in the region shares the host and database, so the project in the username (`postgres.<ref>`) must",
        "match instead of the port. Point --database-url or PRODUCTION_DIRECT_DATABASE_URL (a satellite:",
        "SATELLITE_DIRECT_DATABASE_URL) at production's DIRECT endpoint. If production's pooled URL is not the",
        "direct one with `-pooler` removed (another host or port: Supabase, PgBouncer), store the direct URL on",
        "the project as DATABASE_URL_UNPOOLED (encrypted, not sensitive) so it can be matched. There is no",
        "override for a mismatch.",
      ].join("\n  "),
    });
  }
  if (!hit) {
    if (!input.allowUnverifiedTarget) {
      throw new CliError(
        "Refusing to migrate: production's database could not be read, so the migration URL cannot be checked against it.",
        {
          exitCode: 2,
          hint: [
            `migrating: ${redactUrl(input.url)}`,
            `vercel pull delivered neither DATABASE_URL nor DATABASE_URL_UNPOOLED as a readable postgres:// URL.`,
            `A value stored \`sensitive\` comes back as ${SENSITIVE_PLACEHOLDER}. Store DATABASE_URL_UNPOOLED (production's`,
            "direct URL) encrypted rather than sensitive so it can be matched, or, once you have checked the",
            "endpoint above yourself, re-run with --allow-unverified-target.",
          ].join("\n  "),
        },
      );
    }
    overrides.push(
      "--allow-unverified-target: production's DATABASE_URL and DATABASE_URL_UNPOOLED could not be read, so the database above was NOT checked against production.",
    );
  }

  // The schema. A key absent from the pulled file is unset in production,
  // which boots on the default; a key present but unreadable is unknown.
  const stored = input.production.DB_SCHEMA;
  const production =
    stored === undefined
      ? { value: DEFAULT_SCHEMA, reason: `production sets no DB_SCHEMA, so it reads \`${DEFAULT_SCHEMA}\`` }
      : readable(stored) === null
        ? null
        : { value: readable(stored) as string, reason: "production's DB_SCHEMA" };

  let schema: string;
  let schemaReason: string;
  if (production === null) {
    if (input.schema === undefined || !input.allowUnverifiedTarget) {
      throw new CliError(
        "Refusing to migrate: production's DB_SCHEMA could not be read, so the schema to migrate is unknown.",
        {
          exitCode: 2,
          hint: `It is never guessed. Store DB_SCHEMA as plain (it is not a secret), or pass --schema <production's DB_SCHEMA> with --allow-unverified-target.`,
        },
      );
    }
    schema = input.schema;
    schemaReason = "--schema, NOT checked";
    overrides.push(
      `--allow-unverified-target: production's DB_SCHEMA could not be read, so --schema ${input.schema} was NOT checked against it.`,
    );
  } else if (input.schema === undefined || input.schema === production.value) {
    schema = production.value;
    schemaReason = input.schema === undefined ? production.reason : `--schema, matches ${production.reason}`;
  } else if (input.forceSchema) {
    schema = input.schema;
    schemaReason = `--schema with --force-schema; production reads \`${production.value}\``;
    overrides.push(
      `--force-schema: migrating \`${input.schema}\`, which production does NOT read (it reads \`${production.value}\`).`,
    );
  } else {
    throw new CliError(
      `Refusing to migrate schema \`${input.schema}\`: production reads \`${production.value}\`.`,
      {
        exitCode: 2,
        hint: `Drop --schema to migrate production's schema. Migrating another one leaves the schema production reads behind, so the promoted build meets 503 schema_behind. Pass --force-schema only if migrating a schema production does not read is the point.`,
      },
    );
  }

  return { schema, schemaReason, matched: hit ? { key: hit.key, url: hit.url } : null, overrides };
}
