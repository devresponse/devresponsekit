import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import {
  FOREIGN_KEY_CONSTRAINTS,
  isForeignKeyViolation,
  isUniqueViolation,
  UNIQUE_CONSTRAINTS,
} from "@/db/pg-errors";

/**
 * F-132 — the routes map a constraint violation to their 409 by SQLSTATE and
 * constraint NAME (`src/db/pg-errors.ts`). The unit suites mock the database,
 * so only this suite checks those names against the migrated schema: a
 * migration that renamed one would otherwise turn its 409 back into a 500 with
 * every other check green.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use
 * `__dbtest_pgerr_` and self-clean.
 */
const PREFIX = "__dbtest_pgerr_";

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the statement to be rejected");
}

afterAll(async () => {
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  await pgPool.end();
});

describe("F-132 — every constraint the routes name exists under that name", () => {
  it("each UNIQUE_CONSTRAINTS entry is a unique index (what `pg` reports as `constraint`)", async () => {
    const { rows } = await sql<{ name: string }>`
      select c.relname as name
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where i.indisunique and n.nspname = current_schema()
    `.execute(db);
    const present = new Set(rows.map((r) => r.name));
    expect(UNIQUE_CONSTRAINTS.filter((name) => !present.has(name))).toEqual([]);
  });

  it("each FOREIGN_KEY_CONSTRAINTS entry is a foreign key", async () => {
    const { rows } = await sql<{ name: string }>`
      select con.conname as name
      from pg_constraint con
      join pg_namespace n on n.oid = con.connamespace
      where con.contype = 'f' and n.nspname = current_schema()
    `.execute(db);
    const present = new Set(rows.map((r) => r.name));
    expect(FOREIGN_KEY_CONSTRAINTS.filter((name) => !present.has(name))).toEqual([]);
  });
});

describe("F-132 — a real violation carries the SQLSTATE and constraint the helpers read", () => {
  it("a taken slug is a unique violation of app_organizations_slug_key", async () => {
    const slug = `${PREFIX}slug`;
    await db.insertInto("app_organizations").values({ slug, name: "DBTest pgerr" }).execute();
    const err = await expectRejection(
      db.insertInto("app_organizations").values({ slug, name: "DBTest pgerr 2" }).execute(),
    );
    expect(isUniqueViolation(err, "app_organizations_slug_key")).toBe(true);
    expect(isForeignKeyViolation(err)).toBe(false);
  });

  it("a role naming no org is a foreign-key violation of app_roles_organization_id_fkey", async () => {
    const err = await expectRejection(
      db
        .insertInto("app_roles")
        .values({ organization_id: randomUUID(), key: `${PREFIX}role`, name: "DBTest pgerr" })
        .execute(),
    );
    expect(isForeignKeyViolation(err, "app_roles_organization_id_fkey")).toBe(true);
    expect(isUniqueViolation(err, "app_roles_organization_id_key_key")).toBe(false);
  });
});
