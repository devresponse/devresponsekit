import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeRoleName } from "@/db/runtime-privileges";
import { DB_SCHEMA, resolveDatabaseUrl } from "@/db/schema-config";

/**
 * DB-BACKED proof of `pnpm db:runtime-login` (DEP3): the real script, spawned
 * as an operator runs it, against the migrated test database.
 *
 * - It creates a LOGIN with no other attribute, a member of the runtime role
 *   with INHERIT and without SET, carrying the three role defaults.
 * - Connected as that login with no startup parameters (a pooler's shape),
 *   the search_path resolves to DB_SCHEMA and the ledger reads; ledger
 *   writes, audit updates, app_users deletes and TRUNCATE are refused.
 * - A rerun rotates the password: the old one stops working.
 * - With no runtime role it exits 1 and creates nothing.
 * - Nothing it prints contains the password.
 * - The retire modes (DEP4) drop rotated logins (`<schema>_app_<12 digits>`)
 *   and nothing outside the pattern; keep one with an open session unless
 *   --force; refuse a --retire-except login that does not exist; and work as
 *   Neon's owner, a non-superuser CREATEROLE role that is only an ADMIN
 *   member of the logins it made.
 *
 * Roles are cluster-wide, so every login made here is dropped in afterAll.
 * The retire cases use a scratch schema with its own runtime role and a
 * random name: `auth_runtime` is shared by every database on the cluster, and
 * `--retire-all` against it would reach logins that are not this suite's.
 * Driven by `pnpm test:db` (vitest.db.config.ts).
 */
const RUNTIME = runtimeRoleName(DB_SCHEMA);
const LOGIN = `${DB_SCHEMA}_app_dbtest${randomBytes(4).toString("hex")}`;
const SCRATCH = "__dbtest_rl";
const SCRATCH_LOGIN = `${SCRATCH}_app`;
const DATABASE_URL = resolveDatabaseUrl()!;
const newPassword = () => randomBytes(32).toString("base64url");
let admin: Pool;

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runLogin(env: Record<string, string>, argv: string[]): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/db-runtime-login.ts", ...argv],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL, ...env } as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A plain client as the login: no `options`, so nothing but the role's defaults applies. */
function asLogin(password: string): Client {
  const url = new URL(DATABASE_URL);
  url.username = LOGIN;
  url.password = password;
  return new Client({ connectionString: url.toString() });
}

async function sqlState(client: Client, statement: string): Promise<string | undefined> {
  try {
    await client.query(statement);
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

async function dropRole(name: string) {
  const { rows } = await admin.query("select 1 from pg_roles where rolname = $1", [name]);
  if (rows.length > 0) {
    await admin.query(`drop owned by "${name}"`);
    await admin.query(`drop role "${name}"`);
  }
}

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`drop schema if exists "${SCRATCH}" cascade`);
});

afterAll(async () => {
  try {
    await dropRole(LOGIN);
    await dropRole(SCRATCH_LOGIN);
    await admin.query(`drop schema if exists "${SCRATCH}" cascade`);
  } finally {
    await admin.end();
  }
});

describe("pnpm db:runtime-login against a live database (DEP3)", () => {
  let first: string;

  it("creates a least-privilege login, verifies it, and never prints the password", async () => {
    first = newPassword();
    const ran = await runLogin({ DB_RUNTIME_LOGIN_PASSWORD: first }, ["--login", LOGIN]);
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    const url = new URL(DATABASE_URL);
    expect(ran.stdout).toContain(`[db:runtime-login] created ${LOGIN}`);
    expect(ran.stdout).toContain(
      `[db:runtime-login] login=${LOGIN} host=${url.hostname} database=${url.pathname.slice(1)} verified`,
    );
    expect(ran.stdout + ran.stderr).not.toContain(first);

    const role = await admin.query(
      `select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit
         from pg_roles where rolname = $1`,
      [LOGIN],
    );
    expect(role.rows).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: true,
      },
    ]);
    const member = await admin.query(
      `select g.rolname, m.inherit_option, m.set_option, m.admin_option
         from pg_auth_members m join pg_roles g on g.oid = m.roleid
        where m.member = (select oid from pg_roles where rolname = $1)`,
      [LOGIN],
    );
    expect(member.rows).toEqual([
      { rolname: RUNTIME, inherit_option: true, set_option: false, admin_option: false },
    ]);
    const settings = await admin.query<{ setconfig: string[] }>(
      `select s.setconfig from pg_db_role_setting s
        where s.setrole = (select oid from pg_roles where rolname = $1)
          and s.setdatabase = (select oid from pg_database where datname = current_database())`,
      [LOGIN],
    );
    expect(settings.rows).toHaveLength(1);
    expect(settings.rows[0]!.setconfig.sort()).toEqual(
      [
        `search_path=${DB_SCHEMA}, public`,
        "statement_timeout=30000ms",
        "idle_in_transaction_session_timeout=30000ms",
      ].sort(),
    );
  }, 60_000);

  it("as the login, with no startup parameters: the schema and timeouts apply, and the manifest holds", async () => {
    const client = asLogin(first);
    await client.connect();
    try {
      const { rows } = await client.query(
        `select current_schema() as schema, current_setting('statement_timeout') as st,
                current_setting('idle_in_transaction_session_timeout') as idle`,
      );
      expect(rows[0]).toEqual({ schema: DB_SCHEMA, st: "30s", idle: "30s" });
      expect(
        (await client.query("select count(*)::int as n from app_schema_migrations")).rows[0].n,
      ).toBeGreaterThan(0);
      expect(await sqlState(client, "insert into app_schema_migrations (id) values ('x')")).toBe(
        "42501",
      );
      expect(await sqlState(client, "update app_audit_events set event_type = event_type")).toBe(
        "42501",
      );
      expect(await sqlState(client, "delete from app_users where false")).toBe("42501");
      expect(await sqlState(client, "truncate app_outbox")).toBe("42501");
      // What it may do, it can: a write the runtime holds, rolled back.
      await client.query("begin");
      expect(await sqlState(client, "delete from app_rate_limits where false")).toBeUndefined();
      await client.query("rollback");
    } finally {
      await client.end();
    }
  });

  it("a rerun rotates the password: the old one stops working", async () => {
    const second = newPassword();
    const ran = await runLogin({ DB_RUNTIME_LOGIN_PASSWORD: second }, [`--login=${LOGIN}`]);
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    expect(ran.stdout).toContain(`[db:runtime-login] rotated the password of ${LOGIN}`);
    expect(ran.stdout + ran.stderr).not.toContain(second);

    const old = asLogin(first);
    await expect(old.connect()).rejects.toMatchObject({ code: "28P01" });
    await old.end().catch(() => undefined);
    const fresh = asLogin(second);
    await fresh.connect();
    await fresh.end();
  }, 60_000);

  it("exits 1 and creates nothing when the runtime role does not exist (create mode)", async () => {
    await admin.query(`create schema "${SCRATCH}"`);
    await admin.query(`create table "${SCRATCH}".app_schema_migrations (id text primary key)`);
    const password = newPassword();
    const ran = await runLogin({ DB_SCHEMA: SCRATCH, DB_RUNTIME_LOGIN_PASSWORD: password }, []);
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(1);
    expect(ran.stdout.trim()).toBe(
      `[db:runtime-login] FAILED ${SCRATCH}_runtime does not exist: run pnpm db:app:migrate first (migration 0005 creates it)`,
    );
    expect(ran.stdout + ran.stderr).not.toContain(password);
    const { rows } = await admin.query("select rolname from pg_roles where rolname like $1", [
      `${SCRATCH}%`,
    ]);
    expect(rows).toEqual([]);
  }, 60_000);
});

describe("pnpm db:runtime-login --retire-except / --retire-all against a live database (DEP4)", () => {
  const RT = `__dbtest_rt${randomBytes(4).toString("hex")}`;
  /** A rotated kit login name for the scratch schema: `<schema>_app_` and 12 digits. */
  const rotated = (n: number) => `${RT}_app_2099${String(n).padStart(8, "0")}`;
  const OLD = rotated(1);
  const BUSY = rotated(2);
  const KEEP = rotated(3);
  /** Rotated by name, but no member of the runtime role. */
  const STRANGER = rotated(4);
  /** LOGIN members of the runtime role outside the pattern: never retired. */
  const OUTSIDE = [`${RT}_app`, `${RT}_app_ci`, `${RT}_sat_x`];
  const ALL = [OLD, BUSY, KEEP, STRANGER, ...OUTSIDE];
  const busyPassword = newPassword();

  const NEON = `${RT}n`;
  const NEON_OWNER = `${NEON}_owner`;
  const NEON_LOGIN = `${NEON}_app_209900000001`;
  const neonOwnerPassword = newPassword();

  const exists = async (name: string) =>
    (await admin.query("select 1 from pg_roles where rolname = $1", [name])).rows.length > 0;
  const surviving = async () => {
    const found: string[] = [];
    for (const name of ALL) if (await exists(name)) found.push(name);
    return found;
  };
  const retire = (argv: string[], env: Record<string, string> = {}) =>
    runLogin({ DB_SCHEMA: RT, ...env }, argv);

  beforeAll(async () => {
    await admin.query(`create schema "${RT}"`);
    await admin.query(`create table "${RT}".app_schema_migrations (id text primary key)`);
    await admin.query(`create role "${RT}_runtime" nologin`);
    for (const name of ALL) {
      await admin.query(
        `create role "${name}" login password '${name === BUSY ? busyPassword : newPassword()}'`,
      );
      if (name !== STRANGER) await admin.query(`grant "${RT}_runtime" to "${name}"`);
    }
  });

  afterAll(async () => {
    await admin.query(`drop schema if exists "${RT}" cascade`);
    await admin.query(`drop schema if exists "${NEON}" cascade`);
    for (const name of [...ALL, NEON_LOGIN, `${RT}_runtime`, `${NEON}_runtime`, NEON_OWNER]) {
      await dropRole(name);
    }
  });

  it("keeps a login with an open session, retires the rest of the pattern, and never touches other names", async () => {
    const url = new URL(DATABASE_URL);
    url.username = BUSY;
    url.password = busyPassword;
    const busy = new Client({ connectionString: url.toString() });
    await busy.connect();
    try {
      const ran = await retire(["--retire-except", KEEP]);
      expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(1);
      expect(ran.stdout).toContain(`[db:runtime-login] retired ${OLD}`);
      expect(ran.stdout).toContain(
        `[db:runtime-login] kept ${BUSY}: 1 open session(s) in pg_stat_activity. A pooler keeps idle server connections for a while after its last client, so retry later, or pass --force`,
      );
      expect(ran.stdout).toContain(`[db:runtime-login] FAILED 1 login(s) not retired: ${BUSY}`);
      expect(await surviving()).toEqual([BUSY, KEEP, STRANGER, ...OUTSIDE]);

      // --force: retired although the session is still open.
      const forced = await retire(["--retire-except", KEEP, "--force"]);
      expect(forced.code, `${forced.stdout}\n${forced.stderr}`).toBe(0);
      expect(forced.stdout).toContain(
        `[db:runtime-login] retired ${BUSY} (--force: its 1 open session(s) lose their role)`,
      );
      expect(await surviving()).toEqual([KEEP, STRANGER, ...OUTSIDE]);
    } finally {
      await busy.end().catch(() => undefined);
    }
  }, 60_000);

  it("--retire-except naming a login that does not exist exits 1 and retires nothing", async () => {
    const missing = rotated(99);
    const ran = await retire([`--retire-except=${missing}`]);
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(1);
    expect(ran.stdout.trim()).toBe(
      `[db:runtime-login] FAILED --retire-except ${missing} does not exist: nothing was retired. Name the login production connects as`,
    );
    expect(await surviving()).toEqual([KEEP, STRANGER, ...OUTSIDE]);
  }, 60_000);

  it("--retire-all retires the last rotated login, and still nothing outside the pattern", async () => {
    const ran = await retire(["--retire-all"]);
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    expect(ran.stdout).toContain(`[db:runtime-login] retired ${KEEP}`);
    expect(await surviving()).toEqual([STRANGER, ...OUTSIDE]);

    const again = await retire(["--retire-all"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(
      `[db:runtime-login] nothing to retire: no LOGIN member of ${RT}_runtime is named ${RT}_app_<12 digits>`,
    );
  }, 60_000);

  it("works as Neon's owner: a non-superuser CREATEROLE role, only an ADMIN member of its logins", async () => {
    // neondb_owner's shape: it owns the schema and the ledger, and created
    // the runtime role and the login itself, which from Postgres 16 makes it
    // an ADMIN-only member of each. DROP OWNED needs the login's privileges,
    // which that does not give, so the command must not issue it there.
    await admin.query(
      `create role "${NEON_OWNER}" login createrole password '${neonOwnerPassword}'`,
    );
    await admin.query(`create schema "${NEON}" authorization "${NEON_OWNER}"`);
    const ownerUrl = new URL(DATABASE_URL);
    ownerUrl.username = NEON_OWNER;
    ownerUrl.password = neonOwnerPassword;
    const owner = new Client({ connectionString: ownerUrl.toString() });
    await owner.connect();
    try {
      await owner.query(`create table "${NEON}".app_schema_migrations (id text primary key)`);
      await owner.query(`create role "${NEON}_runtime" nologin`);
      await owner.query(`create role "${NEON_LOGIN}" login password '${newPassword()}'`);
      await owner.query(`grant "${NEON}_runtime" to "${NEON_LOGIN}" with inherit true, set false`);
      const { rows } = await owner.query<{ usage: boolean }>(
        "select pg_has_role(current_user, $1, 'USAGE') as usage",
        [NEON_LOGIN],
      );
      expect(rows).toEqual([{ usage: false }]);
    } finally {
      await owner.end();
    }

    const ran = await runLogin({ DB_SCHEMA: NEON, DATABASE_URL: ownerUrl.toString() }, [
      "--retire-all",
    ]);
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    expect(ran.stdout).toContain(`[db:runtime-login] retired ${NEON_LOGIN}`);
    expect(ran.stdout + ran.stderr).not.toContain(neonOwnerPassword);
    expect(await exists(NEON_LOGIN)).toBe(false);
  }, 60_000);
});
