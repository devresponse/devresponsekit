import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeRoleName } from "@/db/runtime-privileges";
import { DB_SCHEMA, createAppPool } from "@/db/schema-config";

/**
 * DB-BACKED smoke test of what the runtime really does, as the runtime role
 * (DEP3): the row locks, upserts, claims and the definer call the app's hot
 * paths issue, each of which needs more than plain SELECT/INSERT, run under
 * `set local role <DB_SCHEMA>_runtime` on the superuser test connection, in
 * a transaction that is rolled back. And the v1 tightening, each refused with
 * 42501: deleting an `app_users` row, writing the ledger, TRUNCATE.
 *
 * A row lock needs UPDATE on the table (FOR UPDATE, FOR KEY SHARE alike), so
 * a manifest that narrowed one of these tables to SELECT would fail here
 * before it failed a sign-in. Driven by `pnpm test:db` (vitest.db.config.ts).
 */
const ROLE = runtimeRoleName(DB_SCHEMA);
let pool: Pool;
let client: PoolClient;

/** Runs `statement` as the runtime role inside the open transaction, behind a savepoint. */
async function asRuntime(statement: string, values: unknown[] = []) {
  await client.query("savepoint smoke");
  try {
    const result = await client.query(statement, values);
    await client.query("release savepoint smoke");
    return { rows: result.rows, code: undefined as string | undefined };
  } catch (err) {
    await client.query("rollback to savepoint smoke");
    return { rows: [], code: (err as { code?: string }).code };
  }
}

beforeAll(async () => {
  pool = createAppPool({ max: 1 });
  client = await pool.connect();
  await client.query("begin");
  await client.query(`set local role "${ROLE}"`);
});

afterAll(async () => {
  try {
    await client.query("rollback");
  } finally {
    client.release();
    await pool.end();
  }
});

describe(`what the runtime does, as ${ROLE} (DEP3)`, () => {
  it.each(["app_role_permissions", "app_user_roles", '"user"'])(
    "locks %s FOR UPDATE",
    async (table) => {
      expect((await asRuntime(`select 1 from ${table} limit 1 for update`)).code).toBeUndefined();
    },
  );

  it.each(["app_organizations", "app_roles"])("locks %s FOR KEY SHARE", async (table) => {
    expect((await asRuntime(`select 1 from ${table} limit 1 for key share`)).code).toBeUndefined();
  });

  it("consumes a shared rate-limit token: the upsert with RETURNING", async () => {
    const ran = await asRuntime(
      `insert into app_rate_limits as r (key, tokens, updated_at)
       values ($1, 4, now())
       on conflict (key) do update set tokens = r.tokens - 1, updated_at = now()
        where r.tokens >= 1
       returning r.tokens`,
      ["__dbtest_smoke:bucket"],
    );
    expect(ran.code).toBeUndefined();
    expect(ran.rows).toHaveLength(1);
  });

  it("claims an outbox row FOR UPDATE SKIP LOCKED, then deletes it", async () => {
    const claim = await asRuntime(
      `select id from app_outbox where status = 'pending'
        order by next_attempt_at asc nulls first limit 1 for update skip locked`,
    );
    expect(claim.code).toBeUndefined();
    const del = await asRuntime(`delete from app_outbox where id = any($1::uuid[])`, [
      claim.rows.map((row) => (row as { id: string }).id),
    ]);
    expect(del.code).toBeUndefined();
  });

  it("reads the ledger, and prunes audit rows only through the definer function", async () => {
    expect((await asRuntime("select id from app_schema_migrations limit 1")).code).toBeUndefined();
    const prune = await asRuntime("select app_audit_events_prune(30, 10) as n");
    expect(prune.code).toBeUndefined();
    expect(typeof (prune.rows[0] as { n: number }).n).toBe("number");
  });

  it.each<[string, string]>([
    ["deletes an app_users row", "delete from app_users where false"],
    ["writes the ledger", "insert into app_schema_migrations (id) values ('__dbtest_smoke')"],
    ["truncates a table", "truncate app_outbox"],
  ])("is refused with 42501 when it %s", async (_, statement) => {
    expect((await asRuntime(statement)).code).toBe("42501");
  });
});
