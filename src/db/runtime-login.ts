import { pooledReason, repointingParams } from "./connection-shape";
import { describeError } from "./deploy-gate";
import {
  RemoteDatabaseRefusedError,
  assertLocalDatabaseTarget,
  isLocalDatabaseHost,
} from "./guards";
import {
  FORBIDDEN_ATTRIBUTES,
  LOGIN_ROLE_DEFAULTS,
  type PrivilegeReport,
  defaultLoginName,
  isCleanReport,
  isKitLoginName,
  quoteIdent,
  quoteLiteral,
  runtimeRoleName,
} from "./runtime-privileges";
import { scramSha256Verifier } from "./scram";

/**
 * `pnpm db:runtime-login` (DEP3, docs/deployment.md §8): creates, or rotates
 * the password of, a LOGIN role that inherits `<DB_SCHEMA>_runtime`, with the
 * role defaults a pooled connection needs, and proves it by connecting as it.
 *
 * Logins are made here, with SQL, and never in the Neon Console, API or CLI:
 * those put a role in `neon_superuser`, which holds `pg_write_all_data` and
 * bypasses every grant the manifest makes.
 *
 * Inputs: `DATABASE_URL` is the OWNER's direct connection, as for every kit db
 * script, and no other URL variable is read (dotenv refills unset variables in
 * drk-deploy's child, the F-47 failure class). `DB_RUNTIME_LOGIN_PASSWORD` is
 * the login's password, `[A-Za-z0-9_-]{32,128}`, so it embeds in a URL
 * unescaped. Neither the password nor a URL is ever printed.
 *
 * Steps, each failure an exit 1 with a remedy:
 *   1. refuse a pooled or re-pointed owner URL, and a non-local host without
 *      `--allow-remote`; connect as the owner;
 *   2. the session owns `<schema>.app_schema_migrations`, or is a superuser;
 *   3. `<schema>_runtime` exists (0005 creates it);
 *   4. the session may grant it: a superuser, or ADMIN OPTION on it (PG16+);
 *   5. reconcile the runtime role to the manifest;
 *   6. in one transaction, create the login, or rotate an existing one that
 *      has no forbidden attribute and no membership but the runtime role;
 *      grant the runtime role (INHERIT, no SET); set the three role defaults;
 *   7. connect AS the login with a plain client and no startup parameters,
 *      as a transaction pooler would, and check its search_path, its two
 *      timeouts, the ledger read and `verifyCurrentUserPrivileges`;
 *   8. print the login, host, database and `verified`.
 *
 * The logic is here, with every connection injected, so
 * tests/unit/runtime-login.test.ts drives it against a fake; the wiring is
 * scripts/db-runtime-login.ts.
 */

const PREFIX = "[db:runtime-login]";

/** What the password may be: URL-safe as it is, and long enough to be a secret. */
export const LOGIN_PASSWORD_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** A host `--verify-host` may name. */
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

/** The highest `--connection-limit`; -1 means no limit. */
export const MAX_CONNECTION_LIMIT = 100_000;

export interface RuntimeLoginArgs {
  login: string;
  connectionLimit: number;
  allowRemote: boolean;
  verifyHost: string | null;
  plaintextPassword: boolean;
}

export type ParsedArgs = { ok: true; args: RuntimeLoginArgs } | { ok: false; error: string };

/** The command's flags. `--name value` and `--name=value` both work; anything else is refused. */
export function parseRuntimeLoginArgs(argv: readonly string[], schema: string): ParsedArgs {
  const args: RuntimeLoginArgs = {
    login: defaultLoginName(schema),
    connectionLimit: -1,
    allowRemote: false,
    verifyHost: null,
    plaintextPassword: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    const value = (): string | null => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i++;
      return next;
    };
    switch (flag) {
      case "--login": {
        const login = value();
        if (login === null) return { ok: false, error: "--login needs a name" };
        if (login !== defaultLoginName(schema) && !isKitLoginName(schema, login)) {
          return {
            ok: false,
            error: `--login ${login} is not a kit login name: use ${defaultLoginName(schema)}, or ${schema}_app_ and 1 to 24 lower-case letters or digits`,
          };
        }
        args.login = login;
        break;
      }
      case "--connection-limit": {
        const raw = value();
        const n = raw !== null && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
        if (!(n === -1 || (n >= 1 && n <= MAX_CONNECTION_LIMIT))) {
          return {
            ok: false,
            error: `--connection-limit must be -1 (no limit) or 1 to ${MAX_CONNECTION_LIMIT}`,
          };
        }
        args.connectionLimit = n;
        break;
      }
      case "--verify-host": {
        const host = value();
        if (host === null || !HOST_RE.test(host)) {
          return { ok: false, error: "--verify-host needs a host name (no scheme, port or path)" };
        }
        args.verifyHost = host;
        break;
      }
      case "--allow-remote":
      case "--plaintext-password":
        if (inline !== undefined) return { ok: false, error: `${flag} takes no value` };
        if (flag === "--allow-remote") args.allowRemote = true;
        else args.plaintextPassword = true;
        break;
      default:
        return { ok: false, error: `unknown argument ${flag}` };
    }
  }
  return { ok: true, args };
}

/**
 * Why `raw` cannot be the owner connection, or null. Never echoes the URL.
 * A pooled endpoint is refused because role changes and the check after them
 * belong on the direct one; `--verify-host` verifies through the pooler.
 */
export function ownerUrlProblem(raw: string | undefined): string | null {
  if (!raw)
    return "DATABASE_URL is required: the owner's DIRECT connection string, the one db:app:migrate uses";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "DATABASE_URL is not a postgres:// or postgresql:// URL";
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return "DATABASE_URL is not a postgres:// or postgresql:// URL";
  }
  const pooled = pooledReason(url);
  if (pooled) {
    return `DATABASE_URL looks pooled: ${pooled}. Use the owner's DIRECT endpoint, and pass the pooled host with --verify-host to verify through it`;
  }
  const params = repointingParams(url);
  if (params.length > 0) {
    return `DATABASE_URL re-points the connection with ${params.map((p) => `\`${p}\``).join(", ")} in its query: write user, host, port and database in the URL itself`;
  }
  return null;
}

/** The one method the command needs from a connection, and closing it. */
export interface LoginSession {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

export interface RuntimeLoginDeps {
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
  /** `DB_SCHEMA`, already validated by schema-config. */
  schema: string;
  /** The owner's session: `createAppPool`, startup search_path on. */
  connectOwner: () => Promise<LoginSession>;
  /** A plain client to `connectionString`, with no startup parameters. */
  connectLogin: (connectionString: string) => Promise<LoginSession>;
  reconcile: (
    session: LoginSession,
    schema: string,
    log: (line: string) => void,
  ) => Promise<unknown>;
  verify: (session: LoginSession, schema: string) => Promise<PrivilegeReport>;
  log: (line: string) => void;
  /** The SCRAM verifier; injectable so a test can fix the salt. */
  verifier?: (password: string) => string;
}

/** Identity, ownership, the runtime role and the right to grant it, in one round trip. */
const PREFLIGHT_SQL = `
  select current_user as user_name,
         current_database() as database_name,
         current_setting('server_version_num')::int as server_version,
         coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
         (select pg_get_userbyid(c.relowner)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = $1 and c.relname = 'app_schema_migrations') as ledger_owner,
         exists (select 1 from pg_roles where rolname = $2) as runtime_exists,
         exists (select 1 from pg_auth_members m
                  where m.roleid = (select oid from pg_roles where rolname = $2)
                    and m.member = (select oid from pg_roles where rolname = current_user)
                    and m.admin_option) as admin_option`;

const LOGIN_SQL = `
  select r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
         array(select g.rolname::text from pg_auth_members m
                 join pg_roles g on g.oid = m.roleid
                where m.member = r.oid order by 1) as member_of
    from pg_roles r
   where r.rolname = $1`;

const VERIFY_SQL = `
  select current_user as user_name,
         current_schema() as schema_name,
         current_setting('statement_timeout') as statement_timeout,
         current_setting('idle_in_transaction_session_timeout') as idle_timeout`;

interface Preflight {
  user_name: string;
  database_name: string;
  server_version: number;
  superuser: boolean;
  ledger_owner: string | null;
  runtime_exists: boolean;
  admin_option: boolean;
}

/** Runs the command; resolves to the exit code. */
export async function runRuntimeLogin(deps: RuntimeLoginDeps): Promise<number> {
  const { log, schema } = deps;
  const fail = (reason: string) => {
    log(`${PREFIX} FAILED ${reason}`);
    return 1;
  };

  const parsed = parseRuntimeLoginArgs(deps.argv, schema);
  if (!parsed.ok) return fail(parsed.error);
  const { login, connectionLimit, allowRemote, verifyHost, plaintextPassword } = parsed.args;

  const password = deps.env.DB_RUNTIME_LOGIN_PASSWORD ?? "";
  if (!LOGIN_PASSWORD_RE.test(password)) {
    return fail(
      "DB_RUNTIME_LOGIN_PASSWORD must be 32 to 128 characters of A-Z, a-z, 0-9, _ and - (it goes into a connection URL unescaped). " +
        "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
    );
  }

  const ownerUrl = deps.env.DATABASE_URL;
  const urlProblem = ownerUrlProblem(ownerUrl);
  if (urlProblem) return fail(urlProblem);
  try {
    assertLocalDatabaseTarget(ownerUrl!, {
      allowRemote,
      tool: "db:runtime-login",
      consequence: "It creates or rotates a database login and changes the runtime role's grants.",
      overrideHint: "re-run with --allow-remote",
    });
  } catch (err) {
    if (err instanceof RemoteDatabaseRefusedError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  const owner = new URL(ownerUrl!);
  const host = verifyHost ?? owner.hostname;
  if (!allowRemote && !isLocalDatabaseHost(host)) {
    return fail(`--verify-host ${host} is not local: re-run with --allow-remote`);
  }
  const runtime = runtimeRoleName(schema);

  let session: LoginSession;
  let rotated = false;
  try {
    session = await deps.connectOwner();
  } catch (err) {
    return fail(`could not connect as the owner: ${describeError(err)}`);
  }
  try {
    const pre = (await session.query<Preflight>(PREFLIGHT_SQL, [schema, runtime])).rows[0]!;
    if (pre.ledger_owner === null) {
      return fail(`${schema}.app_schema_migrations does not exist: run pnpm db:app:migrate first`);
    }
    if (!pre.superuser && pre.ledger_owner !== pre.user_name) {
      return fail(
        `${pre.user_name} does not own ${schema}.app_schema_migrations (${pre.ledger_owner} does): set DATABASE_URL to the owner's direct connection`,
      );
    }
    if (!pre.runtime_exists) {
      return fail(
        `${runtime} does not exist: run pnpm db:app:migrate first (migration 0005 creates it)`,
      );
    }
    if (!pre.superuser && !pre.admin_option) {
      return fail(
        `${pre.user_name} may not grant ${runtime} (Postgres 16 and later need ADMIN OPTION on it). As a role that holds it, run: grant ${quoteIdent(runtime)} to ${quoteIdent(pre.user_name)} with admin option`,
      );
    }

    await deps.reconcile(session, schema, (line) => log(`${PREFIX} ${line}`));

    const verifier = plaintextPassword
      ? password
      : (deps.verifier ?? scramSha256Verifier)(password);
    const limit = `connection limit ${connectionLimit}`;
    const L = quoteIdent(login);
    await session.query("begin");
    try {
      const existing = (
        await session.query<Record<string, unknown> & { member_of: string[] }>(LOGIN_SQL, [login])
      ).rows[0];
      rotated = existing !== undefined;
      if (existing) {
        const attributes = Object.keys(FORBIDDEN_ATTRIBUTES).filter((c) => existing[c] === true);
        const others = existing.member_of.filter((role) => role !== runtime);
        if (attributes.length > 0 || others.length > 0) {
          await session.query("rollback");
          return fail(
            `${login} exists and is not a kit login: ${[
              ...attributes.map((c) => FORBIDDEN_ATTRIBUTES[c]),
              ...others.map((role) => `member of ${role}`),
            ].join(", ")}. The login was not changed; pick another --login`,
          );
        }
        // A rotation. The forbidden attributes were checked above, and are
        // not restated: Postgres lets only a superuser write NOSUPERUSER (and
        // only a CREATEDB role NOCREATEDB), even when nothing changes.
        await session.query(
          `alter role ${L} with login inherit ${limit} password ${quoteLiteral(verifier)}`,
        );
      } else {
        await session.query(
          `create role ${L} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit ${limit} password ${quoteLiteral(verifier)}`,
        );
      }
      // INHERIT, so the login holds the grants; no SET, so it cannot become
      // the group role. Before 16, membership options do not exist and the
      // login's INHERIT attribute does the same.
      await session.query(
        pre.server_version >= 160000
          ? `grant ${quoteIdent(runtime)} to ${L} with inherit true, set false`
          : `grant ${quoteIdent(runtime)} to ${L}`,
      );
      // Role settings are not inherited through membership: they go on the login.
      for (const setting of LOGIN_ROLE_DEFAULTS(schema)) {
        await session.query(
          `alter role ${L} in database ${quoteIdent(pre.database_name)} set ${setting.name} to ${setting.sql}`,
        );
      }
      await session.query("commit");
    } catch (err) {
      await session.query("rollback").catch(() => undefined);
      return fail(
        `could not create or rotate ${login}: ${describeError(err)}. The login was not changed${
          plaintextPassword
            ? ""
            : "; if the server refuses a pre-hashed SCRAM verifier, re-run with --plaintext-password"
        }`,
      );
    }
    log(`${PREFIX} ${rotated ? "rotated the password of" : "created"} ${login}`);
  } catch (err) {
    return fail(describeError(err));
  } finally {
    await session.end().catch(() => undefined);
  }

  // 7. As the login, the way a transaction pooler connects: no startup
  //    parameters, so search_path and both timeouts must come from the role.
  const url = new URL(ownerUrl!);
  url.username = login;
  url.password = password;
  url.hostname = host;
  url.searchParams.delete("options");
  const problems: string[] = [];
  let as: LoginSession | undefined;
  try {
    as = await deps.connectLogin(url.toString());
    const row = (
      await as.query<{
        user_name: string;
        schema_name: string | null;
        statement_timeout: string;
        idle_timeout: string;
      }>(VERIFY_SQL)
    ).rows[0]!;
    const shown = Object.fromEntries(LOGIN_ROLE_DEFAULTS(schema).map((d) => [d.name, d.shown]));
    if (row.user_name !== login) problems.push(`connected as ${row.user_name}`);
    if (row.schema_name !== schema) {
      problems.push(`search_path resolves to ${row.schema_name ?? "no schema"}, not ${schema}`);
    }
    if (row.statement_timeout !== shown.statement_timeout) {
      problems.push(
        `statement_timeout is ${row.statement_timeout}, not ${shown.statement_timeout}`,
      );
    }
    if (row.idle_timeout !== shown.idle_in_transaction_session_timeout) {
      problems.push(
        `idle_in_transaction_session_timeout is ${row.idle_timeout}, not ${shown.idle_in_transaction_session_timeout}`,
      );
    }
    await as.query("select count(*) from app_schema_migrations");
    const report = await deps.verify(as, schema);
    if (!isCleanReport(report)) {
      for (const [kind, items] of Object.entries(report)) {
        if (items.length > 0) problems.push(`${kind}: ${items.join(", ")}`);
      }
    }
  } catch (err) {
    problems.push(describeError(err));
  } finally {
    await as?.end().catch(() => undefined);
  }
  if (problems.length > 0) {
    // A rotation has already replaced the password of a login a deployment
    // may be using, so "NOT in use" would be wrong there.
    return fail(
      rotated
        ? `the password of ${login} was rotated (a deployment that connects as it needs the new one), but the login failed verification: ${problems.join("; ")}`
        : `login ${login} exists but failed verification; it is NOT in use: ${problems.join("; ")}`,
    );
  }
  log(
    `${PREFIX} login=${login} host=${host} database=${decodeURIComponent(owner.pathname.slice(1))} verified`,
  );
  return 0;
}
