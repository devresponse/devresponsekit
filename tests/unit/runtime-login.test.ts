import { afterAll, describe, expect, it } from "vitest";
import {
  type LoginSession,
  type RuntimeLoginDeps,
  ownerUrlProblem,
  parseRuntimeLoginArgs,
  runRuntimeLogin,
} from "@/db/runtime-login";
import type { PrivilegeReport } from "@/db/runtime-privileges";

/**
 * `pnpm db:runtime-login` (DEP3) against fake connections: the order of its
 * steps, every refusal (each before anything is created), the rotation path,
 * the verification as the login, and that no line it prints ever carries the
 * password. tests/db/runtime-login.db.test.ts runs the real script against
 * Postgres.
 */

const PASSWORD = "Abcdefghijklmnopqrstuvwxyz_0123456789-XYZ";
const OWNER_URL = "postgresql://owner:owner-secret@localhost:5444/devresponse_db";
const CLEAN: PrivilegeReport = { missing: [], forbidden: [], attributes: [], memberships: [] };
/** Every line any run printed, checked for the password once at the end. */
const everyLine: string[] = [];

interface Preflight {
  user_name: string;
  database_name: string;
  server_version: number;
  superuser: boolean;
  ledger_owner: string | null;
  runtime_exists: boolean;
  admin_option: boolean;
}

interface Scenario {
  env?: Record<string, string | undefined>;
  argv?: string[];
  preflight?: Partial<Preflight>;
  existing?: Record<string, unknown> | null;
  failOn?: RegExp;
  verifyRow?: Partial<Record<string, string | null>>;
  report?: PrivilegeReport;
  connectLoginError?: Error;
  connectOwnerError?: Error;
  reconcileError?: Error;
}

interface Run {
  code: number;
  steps: string[];
  lines: string[];
  loginUrl: string | null;
  ownerEnded: boolean;
  loginEnded: boolean;
}

async function run(scenario: Scenario = {}): Promise<Run> {
  const steps: string[] = [];
  const lines: string[] = [];
  const result: Run = {
    code: -1,
    steps,
    lines,
    loginUrl: null,
    ownerEnded: false,
    loginEnded: false,
  };
  const preflight: Preflight = {
    user_name: "owner",
    database_name: "devresponse_db",
    server_version: 170005,
    superuser: false,
    ledger_owner: "owner",
    runtime_exists: true,
    admin_option: true,
    ...scenario.preflight,
  };
  const owner: LoginSession = {
    query: async <R>(text: string) => {
      const sql = text.trim().replace(/\s+/g, " ");
      if (sql.includes("server_version_num")) {
        steps.push("preflight");
        return { rows: [preflight] as R[] };
      }
      if (sql.includes("member_of")) {
        steps.push("login?");
        return { rows: (scenario.existing ? [scenario.existing] : []) as R[] };
      }
      steps.push(sql);
      if (scenario.failOn?.test(sql)) {
        throw Object.assign(new Error("permission denied to create role"), { code: "42501" });
      }
      return { rows: [] as R[] };
    },
    end: async () => {
      result.ownerEnded = true;
    },
  };
  const deps: RuntimeLoginDeps = {
    env: { DATABASE_URL: OWNER_URL, DB_RUNTIME_LOGIN_PASSWORD: PASSWORD, ...scenario.env },
    argv: scenario.argv ?? [],
    schema: "auth",
    connectOwner: async () => {
      if (scenario.connectOwnerError) throw scenario.connectOwnerError;
      return owner;
    },
    connectLogin: async (connectionString) => {
      result.loginUrl = connectionString;
      if (scenario.connectLoginError) throw scenario.connectLoginError;
      const login = new URL(connectionString).username;
      return {
        query: async <R>(text: string) => {
          if (text.includes("current_setting('statement_timeout')")) {
            steps.push("as-login: settings");
            return {
              rows: [
                {
                  user_name: login,
                  schema_name: "auth",
                  statement_timeout: "30s",
                  idle_timeout: "30s",
                  ...scenario.verifyRow,
                },
              ] as R[],
            };
          }
          steps.push(`as-login: ${text}`);
          return { rows: [{ count: "3" }] as R[] };
        },
        end: async () => {
          result.loginEnded = true;
        },
      };
    },
    reconcile: async (_session, schema, log) => {
      steps.push(`reconcile ${schema}`);
      if (scenario.reconcileError) throw scenario.reconcileError;
      log("runtime role auth_runtime: in sync");
    },
    verify: async (_session, schema) => {
      steps.push(`verify ${schema}`);
      return scenario.report ?? CLEAN;
    },
    log: (line) => {
      lines.push(line);
      everyLine.push(line);
    },
    verifier: () => "SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy",
  };
  result.code = await runRuntimeLogin(deps);
  return result;
}

afterAll(() => {
  // The password reaches the login's connection string and nothing else.
  for (const line of everyLine) {
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain("owner-secret");
    expect(line).not.toMatch(/postgres(?:ql)?:\/\/\w/);
  }
  expect(everyLine.length).toBeGreaterThan(30);
});

const ROLE_SETTINGS = [
  'alter role "auth_app" in database "devresponse_db" set search_path to "auth", public',
  `alter role "auth_app" in database "devresponse_db" set statement_timeout to '30000ms'`,
  `alter role "auth_app" in database "devresponse_db" set idle_in_transaction_session_timeout to '30000ms'`,
];

describe("db:runtime-login: the steps (DEP3)", () => {
  it("creates the login in one transaction, then verifies it as the login", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.steps).toEqual([
      "preflight",
      "reconcile auth",
      "begin",
      "login?",
      `create role "auth_app" login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit connection limit -1 password 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy'`,
      'grant "auth_runtime" to "auth_app" with inherit true, set false',
      ...ROLE_SETTINGS,
      "commit",
      "as-login: settings",
      "as-login: select count(*) from app_schema_migrations",
      "verify auth",
    ]);
    expect(r.lines).toEqual([
      "[db:runtime-login] runtime role auth_runtime: in sync",
      "[db:runtime-login] created auth_app",
      "[db:runtime-login] login=auth_app host=localhost database=devresponse_db verified",
    ]);
    expect(r.ownerEnded).toBe(true);
    expect(r.loginEnded).toBe(true);
    // As the login, to the owner's host, with no startup `options`.
    const url = new URL(r.loginUrl!);
    expect([url.username, url.password, url.hostname, url.port, url.pathname]).toEqual([
      "auth_app",
      PASSWORD,
      "localhost",
      "5444",
      "/devresponse_db",
    ]);
  });

  it("rotates an existing kit login: no attribute is restated, the grant and settings are", async () => {
    const r = await run({
      argv: ["--login", "auth_app_ci", "--connection-limit=20"],
      existing: {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        member_of: ["auth_runtime"],
      },
    });
    expect(r.code).toBe(0);
    expect(r.steps).toContain(
      `alter role "auth_app_ci" with login inherit connection limit 20 password 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy'`,
    );
    expect(r.steps.some((s) => s.startsWith("create role"))).toBe(false);
    expect(r.steps).toContain('grant "auth_runtime" to "auth_app_ci" with inherit true, set false');
    expect(r.lines).toContain("[db:runtime-login] rotated the password of auth_app_ci");
  });

  it("before Postgres 16, grants without membership options", async () => {
    const r = await run({ preflight: { server_version: 150008 } });
    expect(r.code).toBe(0);
    expect(r.steps).toContain('grant "auth_runtime" to "auth_app"');
  });

  it("a superuser needs neither the ledger's ownership nor ADMIN OPTION", async () => {
    const r = await run({
      preflight: { superuser: true, ledger_owner: "someone_else", admin_option: false },
    });
    expect(r.code).toBe(0);
  });

  it("--plaintext-password sends the password itself, and still prints none of it", async () => {
    const r = await run({ argv: ["--plaintext-password"] });
    expect(r.code).toBe(0);
    expect(r.steps.find((s) => s.startsWith("create role"))).toContain(`password '${PASSWORD}'`);
  });

  it("verifies through --verify-host, which must be local without --allow-remote", async () => {
    const via = await run({ argv: ["--verify-host", "127.0.0.1"] });
    expect(via.code).toBe(0);
    expect(new URL(via.loginUrl!).hostname).toBe("127.0.0.1");
    expect(via.lines.at(-1)).toContain("host=127.0.0.1 ");

    const remote = await run({ argv: ["--verify-host", "ep-x-pooler.neon.tech"] });
    expect(remote.code).toBe(1);
    expect(remote.steps).toEqual([]);
    expect(remote.lines).toEqual([
      "[db:runtime-login] FAILED --verify-host ep-x-pooler.neon.tech is not local: re-run with --allow-remote",
    ]);
  });

  it("drops an `options` query parameter from the login's URL, as a pooler would", async () => {
    const r = await run({
      env: { DATABASE_URL: `${OWNER_URL}?sslmode=disable&options=-c%20search_path%3Dauth` },
    });
    expect(r.code).toBe(0);
    const url = new URL(r.loginUrl!);
    expect(url.searchParams.has("options")).toBe(false);
    expect(url.searchParams.get("sslmode")).toBe("disable");
  });
});

describe("db:runtime-login: refusals", () => {
  it.each<[string, Scenario, string]>([
    [
      "the runtime role is missing",
      { preflight: { runtime_exists: false } },
      "auth_runtime does not exist: run pnpm db:app:migrate first (migration 0005 creates it)",
    ],
    [
      "the ledger is missing",
      { preflight: { ledger_owner: null } },
      "auth.app_schema_migrations does not exist: run pnpm db:app:migrate first",
    ],
    [
      "the session does not own the ledger",
      { preflight: { ledger_owner: "neondb_owner" } },
      "owner does not own auth.app_schema_migrations (neondb_owner does): set DATABASE_URL to the owner's direct connection",
    ],
    [
      "the owner has no ADMIN OPTION on the runtime role",
      { preflight: { admin_option: false } },
      'owner may not grant auth_runtime (Postgres 16 and later need ADMIN OPTION on it). As a role that holds it, run: grant "auth_runtime" to "owner" with admin option',
    ],
  ])("%s: exit 1 before the reconcile", async (_, scenario, reason) => {
    const r = await run(scenario);
    expect(r.code).toBe(1);
    expect(r.steps).toEqual(["preflight"]);
    expect(r.lines).toEqual([`[db:runtime-login] FAILED ${reason}`]);
    expect(r.ownerEnded).toBe(true);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "an extra membership",
      { member_of: ["auth_runtime", "pg_write_all_data"] },
      "member of pg_write_all_data",
    ],
    ["a forbidden attribute", { rolcreatedb: true, member_of: ["auth_runtime"] }, "CREATEDB"],
  ])(
    "an existing login with %s is refused and the login is not changed",
    async (_, existing, what) => {
      const r = await run({ existing: { rolsuper: false, ...existing } });
      expect(r.code).toBe(1);
      expect(r.steps).toEqual(["preflight", "reconcile auth", "begin", "login?", "rollback"]);
      expect(r.lines.at(-1)).toBe(
        `[db:runtime-login] FAILED auth_app exists and is not a kit login: ${what}. The login was not changed; pick another --login`,
      );
    },
  );

  it.each<[string, string | undefined]>([
    ["missing", undefined],
    ["too short", "a".repeat(31)],
    ["too long", "a".repeat(129)],
    ["not URL-safe", `${"a".repeat(31)}%`],
    ["with a quote", `${"a".repeat(31)}'`],
  ])("refuses a password that is %s, before connecting", async (_, password) => {
    const r = await run({ env: { DB_RUNTIME_LOGIN_PASSWORD: password } });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual([]);
    expect(r.lines[0]).toMatch(
      /^\[db:runtime-login\] FAILED DB_RUNTIME_LOGIN_PASSWORD must be 32 to 128 characters/,
    );
  });

  it("refuses a non-local owner host without --allow-remote, and accepts it with", async () => {
    const remote = "postgresql://owner:owner-secret@ep-x.neon.tech/neondb?sslmode=require";
    const refused = await run({ env: { DATABASE_URL: remote } });
    expect(refused.code).toBe(1);
    expect(refused.steps).toEqual([]);
    expect(refused.lines[0]).toMatch(
      /^\[db:runtime-login\] REFUSING: host "ep-x\.neon\.tech" \(database "neondb"\) is not local\./,
    );
    const allowed = await run({ env: { DATABASE_URL: remote }, argv: ["--allow-remote"] });
    expect(allowed.code).toBe(0);
    expect(new URL(allowed.loginUrl!).hostname).toBe("ep-x.neon.tech");
  });

  it.each<[string, string | undefined, RegExp]>([
    ["missing", undefined, /^DATABASE_URL is required/],
    ["not a URL", "not a url", /^DATABASE_URL is not a postgres/],
    ["not postgres", "mysql://u:p@localhost/db", /^DATABASE_URL is not a postgres/],
    [
      "pooled",
      "postgresql://u:p@ep-a-pooler.neon.tech/db",
      /^DATABASE_URL looks pooled: .*--verify-host/,
    ],
    [
      "re-pointed",
      "postgresql://u:p@localhost/db?host=elsewhere",
      /re-points the connection with `host`/,
    ],
  ])("refuses an owner URL that is %s, before connecting", async (_, url, reason) => {
    expect(ownerUrlProblem(url)).toMatch(reason);
    const r = await run({ env: { DATABASE_URL: url } });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual([]);
  });

  it("fails cleanly when the owner cannot connect, or a statement fails", async () => {
    const down = await run({
      connectOwnerError: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5444"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(down.code).toBe(1);
    expect(down.lines).toEqual([
      "[db:runtime-login] FAILED could not connect as the owner: ECONNREFUSED connect ECONNREFUSED 127.0.0.1:5444",
    ]);

    const refused = await run({ failOn: /^create role/ });
    expect(refused.code).toBe(1);
    expect(refused.steps.at(-1)).toBe("rollback");
    expect(refused.lines.at(-1)).toBe(
      "[db:runtime-login] FAILED could not create or rotate auth_app: 42501 permission denied to create role. The login was not changed; if the server refuses a pre-hashed SCRAM verifier, re-run with --plaintext-password",
    );
    const plain = await run({ failOn: /^create role/, argv: ["--plaintext-password"] });
    expect(plain.lines.at(-1)).toMatch(/The login was not changed$/);

    const reconcile = await run({
      reconcileError: new Error("runtime role auth_runtime: still out of line after the repair"),
    });
    expect(reconcile.code).toBe(1);
    expect(reconcile.steps).toEqual(["preflight", "reconcile auth"]);
    expect(reconcile.lines.at(-1)).toBe(
      "[db:runtime-login] FAILED runtime role auth_runtime: still out of line after the repair",
    );
    expect(reconcile.ownerEnded).toBe(true);
  });
});

describe("db:runtime-login: verification as the login", () => {
  it.each<[string, Scenario, string]>([
    [
      "its search_path",
      { verifyRow: { schema_name: "public" } },
      "search_path resolves to public, not auth",
    ],
    [
      "no schema at all",
      { verifyRow: { schema_name: null } },
      "search_path resolves to no schema, not auth",
    ],
    [
      "its statement_timeout",
      { verifyRow: { statement_timeout: "0" } },
      "statement_timeout is 0, not 30s",
    ],
    [
      "its idle timeout",
      { verifyRow: { idle_timeout: "0" } },
      "idle_in_transaction_session_timeout is 0, not 30s",
    ],
    ["who it is", { verifyRow: { user_name: "someone" } }, "connected as someone"],
    [
      "its privileges",
      { report: { ...CLEAN, forbidden: ["TRUNCATE on app_outbox"], memberships: ["owner"] } },
      "forbidden: TRUNCATE on app_outbox; memberships: owner",
    ],
    [
      "the connection itself",
      {
        connectLoginError: Object.assign(
          new Error('password authentication failed for user "auth_app"'),
          {
            code: "28P01",
          },
        ),
      },
      '28P01 password authentication failed for user "auth_app"',
    ],
  ])("a login that fails on %s exits 1, NOT in use", async (_, scenario, problem) => {
    const r = await run(scenario);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe(
      `[db:runtime-login] FAILED login auth_app exists but failed verification; it is NOT in use: ${problem}`,
    );
  });

  it("after a rotation, says the password was rotated, not that the login is unused", async () => {
    const r = await run({
      existing: { rolsuper: false, member_of: ["auth_runtime"] },
      verifyRow: { statement_timeout: "0" },
    });
    expect(r.code).toBe(1);
    expect(r.lines).toContain("[db:runtime-login] rotated the password of auth_app");
    expect(r.lines.at(-1)).toBe(
      "[db:runtime-login] FAILED the password of auth_app was rotated (a deployment that connects as it needs the new one), but the login failed verification: statement_timeout is 0, not 30s",
    );
  });
});

describe("parseRuntimeLoginArgs", () => {
  it("defaults, and reads both flag forms", () => {
    expect(parseRuntimeLoginArgs([], "auth")).toEqual({
      ok: true,
      args: {
        login: "auth_app",
        connectionLimit: -1,
        allowRemote: false,
        verifyHost: null,
        plaintextPassword: false,
      },
    });
    expect(
      parseRuntimeLoginArgs(
        [
          "--login=auth_app_x1",
          "--connection-limit",
          "5",
          "--verify-host=db.local",
          "--allow-remote",
        ],
        "auth",
      ),
    ).toEqual({
      ok: true,
      args: {
        login: "auth_app_x1",
        connectionLimit: 5,
        allowRemote: true,
        verifyHost: "db.local",
        plaintextPassword: false,
      },
    });
  });

  it.each<[string[], RegExp]>([
    [["--login"], /^--login needs a name$/],
    [["--login", "--allow-remote"], /^--login needs a name$/],
    [["--login", "auth_sat_x"], /^--login auth_sat_x is not a kit login name/],
    [["--login=auth_runtime"], /is not a kit login name/],
    [["--connection-limit", "0"], /^--connection-limit must be -1/],
    [["--connection-limit", "-2"], /^--connection-limit must be -1/],
    [["--connection-limit", "100001"], /^--connection-limit must be -1/],
    [["--connection-limit", "1.5"], /^--connection-limit must be -1/],
    [["--connection-limit"], /^--connection-limit must be -1/],
    [["--verify-host", "db:5432"], /^--verify-host needs a host name/],
    [["--verify-host"], /^--verify-host needs a host name/],
    [["--allow-remote=yes"], /^--allow-remote takes no value$/],
    [["--plaintext-password=1"], /^--plaintext-password takes no value$/],
    [["--force"], /^unknown argument --force$/],
  ])("refuses %j", (argv, error) => {
    const parsed = parseRuntimeLoginArgs(argv, "auth");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(error);
  });

  it("an unknown flag is refused before anything connects", async () => {
    const r = await run({ argv: ["--yes"] });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual([]);
    expect(r.lines).toEqual(["[db:runtime-login] FAILED unknown argument --yes"]);
  });
});
