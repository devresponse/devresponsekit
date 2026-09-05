import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgPool } from "@/db/database";

/**
 * DB-BACKED proof that migration 0004-integrity-constraints.sql refuses to run
 * against data that violates a constraint it adds — and that its refusal
 * leaves the database untouched, names every offender, and that the file is
 * idempotent once the data is clean (source review 2026-09-04, #217 rollout
 * shape).
 *
 * The migrated dev/CI database already carries the constraints, so the
 * scenario is built in a SCRATCH SCHEMA on a dedicated connection: apply the
 * frozen baseline (0001–0003) there, plant offending rows, run 0004 in a
 * transaction exactly as the runner does, and inspect. The schema (and the
 * `<schema>_runtime` role 0004 creates for it) are dropped afterwards.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts).
 */
const SCHEMA = "__dbtest_m0004";
const RUNTIME_ROLE = `${SCHEMA}_runtime`;
const MIGRATIONS_DIR = path.resolve(__dirname, "../../src/db/migrations");
const read = (file: string) => readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

let client: PoolClient;

/** Runs `sql` inside a transaction on the scratch schema; rolls back on error and rethrows. */
async function applyInTransaction(sql: string): Promise<void> {
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function constraintExists(table: string, name: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `select exists (
       select 1 from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace n on n.oid = rel.relnamespace
       where n.nspname = $1 and rel.relname = $2 and con.conname = $3
     ) as ok`,
    [SCHEMA, table, name],
  );
  return rows[0]!.ok;
}

beforeAll(async () => {
  client = await pgPool.connect();
  await client.query(`drop schema if exists "${SCHEMA}" cascade`);
  await client.query(`create schema "${SCHEMA}"`);
  await client.query(`set search_path to "${SCHEMA}", public`);
  for (const file of [
    "0001-initial-schema.sql",
    "0002-admin-groups-permissions.sql",
    "0003-outbox-delivery-payload.sql",
  ]) {
    await applyInTransaction(read(file));
  }
});

afterAll(async () => {
  try {
    await client.query(`drop schema if exists "${SCHEMA}" cascade`);
    const { rows } = await client.query(`select 1 from pg_roles where rolname = $1`, [
      RUNTIME_ROLE,
    ]);
    if (rows.length > 0) {
      await client.query(`drop owned by "${RUNTIME_ROLE}"`);
      await client.query(`drop role "${RUNTIME_ROLE}"`);
    }
  } finally {
    client.release();
    await pgPool.end();
  }
});

describe("0004 preflight (scratch schema)", () => {
  it("refuses with every offender listed and leaves the schema unchanged", async () => {
    // One offender per kind the preflight covers.
    await client.query(`
      insert into app_enterprise_applications (id, label, origin, subdomain, sso_audience, status)
      values ('deg', 'Degraded', 'https://deg.example.test', 'deg', 'aud-deg', 'degraded'),
             ('dup1', 'Dup 1', 'https://d1.example.test', 'd1', 'aud-shared', 'available'),
             ('dup2', 'Dup 2', 'https://d2.example.test', 'd2', 'aud-shared', 'available');
      insert into app_organizations (slug, name, status) values ('bad-status', 'Bad', 'bogus');
      insert into app_organizations (slug, name) values ('org-a', 'A'), ('org-b', 'B');
      insert into app_organization_invitations (organization_id, email, token_hash, expires_at)
      select id, 'Mixed@Example.test', 'tok-1', now() + interval '1 day' from app_organizations where slug = 'org-a';
      insert into app_roles (organization_id, key, name)
      select id, 'b-role', 'B role' from app_organizations where slug = 'org-b';
      insert into app_groups (organization_id, key, name)
      select id, 'a-group', 'A group' from app_organizations where slug = 'org-a';
      insert into app_group_roles (group_id, role_id)
      select g.id, r.id from app_groups g, app_roles r where g.key = 'a-group' and r.key = 'b-role';
      insert into app_users (better_auth_user_id, primary_email, status) values ('ba-u', 'u@example.test', 'active');
      insert into app_user_roles (app_user_id, organization_id, role_id)
      select u.id, o.id, r.id from app_users u, app_organizations o, app_roles r
      where u.better_auth_user_id = 'ba-u' and o.slug = 'org-a' and r.key = 'b-role';
    `);

    let message = "";
    try {
      await applyInTransaction(read("0004-integrity-constraints.sql"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/\[0004\] refusing to apply: 6 row group\(s\)/);
    expect(message).toContain("app_enterprise_applications.status = 'degraded' (1 rows)");
    expect(message).toContain("app_enterprise_applications.sso_audience = 'aud-shared' (2 rows)");
    expect(message).toContain("app_organizations.status = 'bogus' (1 rows)");
    expect(message).toContain("app_organization_invitations.email = 'Mixed@Example.test' (1 rows)");
    expect(message).toMatch(/app_group_roles\.role_id = '[0-9a-f-]{36}' \(1 rows\)/);
    expect(message).toMatch(/app_user_roles\.role_id = '[0-9a-f-]{36}' \(1 rows\)/);

    // Nothing was applied: no constraint, no index, no column, no role.
    expect(await constraintExists("app_organizations", "app_organizations_status_check")).toBe(
      false,
    );
    expect(await constraintExists("app_group_roles", "app_group_roles_role_org_fkey")).toBe(false);
    const idx = await client.query(
      `select 1 from pg_indexes where schemaname = $1 and indexname = 'idx_app_enterprise_applications_sso_audience'`,
      [SCHEMA],
    );
    expect(idx.rowCount).toBe(0);
    const col = await client.query(
      `select 1 from information_schema.columns where table_schema = $1 and table_name = 'app_group_roles' and column_name = 'organization_id'`,
      [SCHEMA],
    );
    expect(col.rowCount).toBe(0);
    const role = await client.query(`select 1 from pg_roles where rolname = $1`, [RUNTIME_ROLE]);
    expect(role.rowCount).toBe(0);
  });

  it("applies once the offenders are fixed, and applying again is a no-op", async () => {
    await client.query(`
      delete from app_user_roles;
      delete from app_group_roles;
      delete from app_organization_invitations;
      delete from app_enterprise_applications where id in ('deg', 'dup2');
      update app_organizations set status = 'archived' where slug = 'bad-status';
    `);

    await applyInTransaction(read("0004-integrity-constraints.sql"));
    expect(await constraintExists("app_organizations", "app_organizations_status_check")).toBe(
      true,
    );
    expect(await constraintExists("app_users", "app_users_status_check")).toBe(true);
    expect(await constraintExists("app_group_roles", "app_group_roles_role_org_fkey")).toBe(true);
    expect(await constraintExists("app_user_roles", "app_user_roles_role_org_fkey")).toBe(true);
    const validated = await client.query<{ n: string }>(
      `select count(*) filter (where not con.convalidated) as n
       from pg_constraint con join pg_class rel on rel.oid = con.conrelid
       join pg_namespace ns on ns.oid = rel.relnamespace where ns.nspname = $1`,
      [SCHEMA],
    );
    expect(Number(validated.rows[0]!.n)).toBe(0);
    const role = await client.query<{ rolcanlogin: boolean }>(
      `select rolcanlogin from pg_roles where rolname = $1`,
      [RUNTIME_ROLE],
    );
    expect(role.rows).toEqual([{ rolcanlogin: false }]);

    // Idempotent re-run: every guard short-circuits, nothing throws.
    await applyInTransaction(read("0004-integrity-constraints.sql"));
    expect(await constraintExists("app_organizations", "app_organizations_status_check")).toBe(
      true,
    );
  });
});
