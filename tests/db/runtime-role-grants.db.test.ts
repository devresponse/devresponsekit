import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileRuntimePrivileges } from "@/db/migrations/runtime-privileges-db";
import {
  FUNCTION_GRANTS,
  TABLE_GRANTS,
  TABLE_PRIVILEGES,
  functionSignature,
  runtimeRoleName,
} from "@/db/runtime-privileges";
import { DB_SCHEMA, resolveDatabaseUrl } from "@/db/schema-config";

/**
 * DB-BACKED proof of the runtime role's privilege manifest (DEP3) on the
 * migrated test database: the catalog matches the manifest, the role cannot
 * reach past it, and the reconcile that ends every `pnpm db:app:migrate` is
 * idempotent, repairs drift, refuses what it cannot revoke, and notices when
 * Postgres only warned instead of changing anything.
 *
 * The test database must have been migrated by this build's runner (CI's
 * quality job does it right before `pnpm test:db`), whose last step is that
 * reconcile. Every drift a case makes is repaired in its `finally`.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts).
 */
const ROLE = runtimeRoleName(DB_SCHEMA);
const SCRATCH_ROLE = "__dbtest_rg_nonowner";
let pool: Pool;
let client: PoolClient;
const lines: string[] = [];
const log = (line: string) => void lines.push(line);
const q = (table: string) => `"${DB_SCHEMA}"."${table}"`;

async function effective(table: string): Promise<string[]> {
  const { rows } = await client.query<{ privileges: string[] }>(
    `select array(select p from unnest($3::text[]) p
                   where has_table_privilege($1::name, format('%I.%I', $2::text, $4::text), p)) as privileges`,
    [ROLE, DB_SCHEMA, TABLE_PRIVILEGES, table],
  );
  return rows[0]!.privileges;
}

async function reconcile() {
  lines.length = 0;
  return reconcileRuntimePrivileges(client, DB_SCHEMA, log);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: resolveDatabaseUrl(), max: 1 });
  client = await pool.connect();
  await client.query(`drop role if exists "${SCRATCH_ROLE}"`);
});

afterAll(async () => {
  try {
    await reconcile();
    const { rows } = await client.query("select 1 from pg_roles where rolname = $1", [
      SCRATCH_ROLE,
    ]);
    if (rows.length > 0) {
      await client.query(`drop owned by "${SCRATCH_ROLE}"`);
      await client.query(`drop role "${SCRATCH_ROLE}"`);
    }
  } finally {
    client.release();
    await pool.end();
  }
});

describe(`the runtime role ${ROLE} against the privilege manifest (DEP3)`, () => {
  it("every table in DB_SCHEMA is in the manifest", async () => {
    const { rows } = await client.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p') order by 1`,
      [DB_SCHEMA],
    );
    expect(rows.length).toBeGreaterThan(25);
    expect(rows.map((r) => r.relname).sort()).toEqual(Object.keys(TABLE_GRANTS).sort());
  });

  it("holds exactly the manifest on every table, from any source", async () => {
    for (const [table, privileges] of Object.entries(TABLE_GRANTS)) {
      expect(await effective(table), table).toEqual(
        TABLE_PRIVILEGES.filter((p) => (privileges as readonly string[]).includes(p)),
      );
    }
    const fns = await client.query<{ ok: boolean }>(
      `select has_function_privilege($1::name, to_regprocedure(sig), 'EXECUTE') as ok
         from unnest($2::text[]) sig`,
      [ROLE, FUNCTION_GRANTS.map((fn) => `"${DB_SCHEMA}".${functionSignature(fn)}`)],
    );
    expect(fns.rows.map((r) => r.ok)).toEqual(FUNCTION_GRANTS.map(() => true));
  });

  it("no SECURITY DEFINER function in DB_SCHEMA is executable by PUBLIC", async () => {
    const { rows } = await client.query<{ proname: string; public_exec: boolean }>(
      `select p.proname,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.prosecdef`,
      [DB_SCHEMA],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual(FUNCTION_GRANTS.map((fn) => fn.name).sort());
    expect(rows.filter((r) => r.public_exec)).toEqual([]);
  });

  it("is NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOBYPASSRLS, with no CREATE on the schema or the database", async () => {
    const { rows } = await client.query(
      `select rolcanlogin, rolsuper, rolcreaterole, rolbypassrls, rolcreatedb, rolreplication,
              has_schema_privilege(rolname, $2::text, 'CREATE') as schema_create,
              has_database_privilege(rolname, current_database(), 'CREATE') as database_create
         from pg_roles where rolname = $1`,
      [ROLE, DB_SCHEMA],
    );
    expect(rows).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolreplication: false,
        schema_create: false,
        database_create: false,
      },
    ]);
  });

  it("every table is owned by the ledger's owner", async () => {
    const { rows } = await client.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p')
          and c.relowner <> (select relowner from pg_class where oid = to_regclass($2))`,
      [DB_SCHEMA, `"${DB_SCHEMA}".app_schema_migrations`],
    );
    expect(rows).toEqual([]);
  });

  it("app_audit_events' foreign keys are NO ACTION or SET NULL: a CASCADE would purge audit rows as the owner", async () => {
    const { rows } = await client.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint
        where conrelid = to_regclass($1) and contype = 'f' order by 1`,
      [`"${DB_SCHEMA}".app_audit_events`],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(["a", "n"], row.conname).toContain(row.confdeltype);
  });
});

describe("reconcileRuntimePrivileges (DEP3)", () => {
  it("is idempotent: a second run is in sync and issues nothing", async () => {
    await reconcile();
    const second = await reconcile();
    expect(second).toEqual({
      status: "reconciled",
      role: ROLE,
      grants: 0,
      revokes: 0,
      statements: [],
      unlisted: [],
    });
    expect(lines).toEqual([`runtime role ${ROLE}: in sync`]);
  });

  it("repairs drift: an extra ledger UPDATE is revoked, a missing session SELECT re-granted", async () => {
    await client.query(`grant update on ${q("app_schema_migrations")} to "${ROLE}"`);
    await client.query(`revoke select on ${q("session")} from "${ROLE}"`);
    try {
      expect(await effective("app_schema_migrations")).toContain("UPDATE");
      expect(await effective("session")).not.toContain("SELECT");
      const result = await reconcile();
      expect(result).toMatchObject({ status: "reconciled", grants: 1, revokes: 1 });
      expect(lines).toEqual([`runtime role ${ROLE}: 1 grants, 1 revokes`]);
      expect(await effective("app_schema_migrations")).toEqual(["SELECT"]);
      expect(await effective("session")).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
    } finally {
      await reconcile();
    }
  });

  it("refuses, changing nothing, a forbidden privilege that comes from PUBLIC", async () => {
    await client.query(`grant update on ${q("app_schema_migrations")} to "${ROLE}"`);
    await client.query(`grant delete on ${q("app_users")} to public`);
    try {
      await expect(reconcile()).rejects.toThrow(
        `${ROLE} holds DELETE on app_users through PUBLIC: revoke delete on app_users from public, as the owner`,
      );
      // Nothing applied: the unrelated ledger drift is still there.
      expect(await effective("app_schema_migrations")).toContain("UPDATE");
    } finally {
      await client.query(`revoke delete on ${q("app_users")} from public`);
      await reconcile();
    }
  });

  it("throws when Postgres only warned: a migrating role that does not own the tables", async () => {
    await client.query(`create role "${SCRATCH_ROLE}" nologin`);
    await client.query(`grant usage on schema "${DB_SCHEMA}" to "${SCRATCH_ROLE}"`);
    await client.query(`grant select on ${q("app_schema_migrations")} to "${SCRATCH_ROLE}"`);
    await client.query(`grant update on ${q("app_schema_migrations")} to "${ROLE}"`);
    try {
      await client.query(`set role "${SCRATCH_ROLE}"`);
      await expect(reconcile()).rejects.toThrow(
        new RegExp(
          `^runtime role ${ROLE}: still out of line after the repair, so the migrating role does not own every table`,
        ),
      );
    } finally {
      await client.query("reset role");
      await client.query(`drop owned by "${SCRATCH_ROLE}"`);
      await client.query(`drop role "${SCRATCH_ROLE}"`);
      await reconcile();
    }
    expect(await effective("app_schema_migrations")).toEqual(["SELECT"]);
  });

  it("reports a missing role and creates nothing", async () => {
    lines.length = 0;
    const result = await reconcileRuntimePrivileges(client, "__dbtest_rg_absent", log);
    expect(result).toEqual({ status: "absent", role: "__dbtest_rg_absent_runtime" });
    expect(lines).toEqual([
      "warning: __dbtest_rg_absent_runtime does not exist; runtime privileges not reconciled (docs/deployment.md §8)",
    ]);
    const { rows } = await client.query("select 1 from pg_roles where rolname = $1", [
      "__dbtest_rg_absent_runtime",
    ]);
    expect(rows).toEqual([]);
  });
});
