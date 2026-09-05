import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";

/**
 * DB-BACKED integration tests for DB-1 (org DELETE foreign-key handling).
 *
 * These run the real ON DELETE behavior from migration 0005 against Postgres,
 * proving the subtle interaction the unit/integration mocks can't reach:
 *
 *   1. Deleting an org that has audit history SUCCEEDS — the audit row survives
 *      with a null organization_id (ON DELETE SET NULL), and the 0005
 *      append-only trigger PERMITS that exact tombstone UPDATE.
 *   2. Deleting an org that still owns a role raises a FK violation (the row
 *      the route catches and maps to a 409 `organization_in_use`).
 *   3. The append-only guarantee on audit CONTENT is preserved — the trigger
 *      still rejects content UPDATEs, ad-hoc DELETEs, and an org-null UPDATE
 *      that also changes another column.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts), excluded from `pnpm test`.
 * All fixtures use a `__dbtest_` prefix and self-clean, leaving no residue.
 */
const PREFIX = "__dbtest_orgdel_";

async function cleanup(): Promise<void> {
  // Audit rows are append-only; the sanctioned retention GUC is the only path
  // that may delete them (matches the D3 retention job).
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("event_type", "like", `${PREFIX}%`).execute();
  });
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(slug: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest ${slug}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("organization DELETE foreign-key behavior (DB-backed, DB-1)", () => {
  it("deletes an org with audit history; the audit row survives with a null org (SET NULL tombstone)", async () => {
    const orgId = await newOrg("audit");
    await db
      .insertInto("app_audit_events")
      .values({
        event_type: `${PREFIX}probe`,
        outcome: "success",
        organization_id: orgId,
        reason: "before-delete",
      })
      .execute();

    // Only the audit FK references this org — the delete must succeed.
    await db.deleteFrom("app_organizations").where("id", "=", orgId).execute();

    const org = await db
      .selectFrom("app_organizations")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    expect(org).toBeUndefined();

    const audit = await db
      .selectFrom("app_audit_events")
      .select(["organization_id", "reason"])
      .where("event_type", "=", `${PREFIX}probe`)
      .executeTakeFirst();
    expect(audit).toBeDefined();
    expect(audit?.organization_id).toBeNull();
    // Content is untouched — only the tenant link was severed.
    expect(audit?.reason).toBe("before-delete");
  });

  it("raises a FK violation when the org still owns a role (the route maps this to 409)", async () => {
    const orgId = await newOrg("role");
    await db
      .insertInto("app_roles")
      .values({ organization_id: orgId, key: `${PREFIX}r`, name: "DBTest Role" })
      .execute();

    await expect(
      db.deleteFrom("app_organizations").where("id", "=", orgId).execute(),
    ).rejects.toThrow(/foreign key/i);
  });

  it("keeps audit rows append-only: content UPDATE, ad-hoc DELETE, and null-org-plus-edit are all rejected", async () => {
    const orgId = await newOrg("trigger");
    await db
      .insertInto("app_audit_events")
      .values({
        event_type: `${PREFIX}trig`,
        outcome: "success",
        organization_id: orgId,
        reason: "immutable",
      })
      .execute();

    // A pure content edit (org unchanged) is rejected.
    await expect(
      db
        .updateTable("app_audit_events")
        .set({ reason: "tampered" })
        .where("event_type", "=", `${PREFIX}trig`)
        .execute(),
    ).rejects.toThrow(/append-only/i);

    // Nulling the org is permitted ONLY when nothing else changes — coupling it
    // with another edit must still be rejected (narrow tombstone exception).
    await expect(
      db
        .updateTable("app_audit_events")
        .set({ organization_id: null, reason: "tampered" })
        .where("event_type", "=", `${PREFIX}trig`)
        .execute(),
    ).rejects.toThrow(/append-only/i);

    // An ad-hoc DELETE without the retention GUC is rejected.
    await expect(
      db.deleteFrom("app_audit_events").where("event_type", "=", `${PREFIX}trig`).execute(),
    ).rejects.toThrow(/append-only/i);
  });
});
