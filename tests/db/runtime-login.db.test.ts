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
 *
 * Roles are cluster-wide, so every login made here is dropped in afterAll.
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

  it("exits 1 and creates nothing when the runtime role does not exist", async () => {
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
