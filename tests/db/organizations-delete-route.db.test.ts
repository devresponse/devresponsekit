import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for DB-3 (the tenant-DELETE success audit).
 *
 * `tests/db/organizations-delete.db.test.ts` covers the RAW schema behaviour
 * (DB-1: the ON DELETE SET NULL tombstone and the append-only trigger) and
 * `tests/integration/administrator-organizations.test.ts` covers the handler
 * contract — but the integration suite MOCKS `@/lib/audit.server`, so no
 * existing test ever ran the real audit INSERT against the real FK. That gap
 * is exactly where DB-3 lived: the success row was inserted AFTER the delete,
 * naming an `organization_id` whose parent was already gone, which is a
 * foreign-key violation no `ON DELETE` rule can rescue (that rule governs rows
 * that already exist, not new inserts). Every successful tenant delete ended in
 * an unhandled 500 and `admin.organization.deleted` was never written.
 *
 * So this file drives the REAL `DELETE` handler against real Postgres with
 * `auditEvent` NOT mocked — only auth is stubbed — and asserts:
 *   1. a clean delete returns 2xx, the org is gone, and the
 *      `admin.organization.deleted` row is actually there; and
 *   2. a delete blocked by another FK rolls the success row back, so no audit
 *      row ever claims a deletion that did not happen;
 *   3. F-98: the org's REVOKED API keys and OAuth clients go with it, while an
 *      ACTIVE one still refuses the delete (409) and the revoked ones then
 *      roll back with everything else.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_` and
 * self-clean, leaving no residue.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});

const { db, pgPool } = await import("@/db/database");
const { DELETE } = await import("@/app/api/administrator/organizations/[id]/route");

const PREFIX = "__dbtest_orgdelroute_";
/**
 * `actor_better_auth_user_id` is plain text (no FK), so a prefixed literal is
 * both a safe actor identity and the handle cleanup uses to find every row this
 * file wrote — the event types are the production ones and must not be matched
 * on.
 */
const ACTOR = `${PREFIX}admin`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-orgdelroute-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.orgs.delete", "superuser"],
};

function deleteReq(id: string): NextRequest {
  const url = new URL(`http://test.local/api/administrator/organizations/${id}`);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "DELETE",
  } as unknown as NextRequest;
}

async function cleanup(): Promise<void> {
  // Audit rows are append-only; the sanctioned retention GUC is the only path
  // that may delete them (matches the D3 retention job).
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
  });
  await db.deleteFrom("app_api_keys").where("name", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_oauth_clients").where("name", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
}

async function newOrg(slug: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest ${slug}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The user every credential fixture acts as (both tables require one). */
async function credentialOwner(): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}owner`,
      primary_email: `${PREFIX}owner@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

type CredentialKind = "api_key" | "oauth_client";
type CredentialStatus = "active" | "revoked";

let credentialSeq = 0;
/** Inserts a key or client for `orgId` and returns its row id. */
async function newCredential(
  kind: CredentialKind,
  orgId: string,
  ownerId: string,
  status: CredentialStatus,
): Promise<string> {
  credentialSeq += 1;
  const name = `${PREFIX}${kind}_${status}_${credentialSeq}`;
  const revoked = status === "revoked" ? { revoked_at: new Date() } : {};
  const row =
    kind === "api_key"
      ? await db
          .insertInto("app_api_keys")
          .values({
            app_user_id: ownerId,
            organization_id: orgId,
            name,
            key_prefix: "dbt",
            key_hash: `${name}_hash`,
            status,
            ...revoked,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      : await db
          .insertInto("app_oauth_clients")
          .values({
            client_id: `${name}_client`,
            client_secret_hash: `${name}_hash`,
            app_user_id: ownerId,
            organization_id: orgId,
            name,
            status,
            ...revoked,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
  return row.id;
}

/** The ids, among `ids`, whose credential rows still exist. */
async function survivingCredentials(ids: string[]): Promise<string[]> {
  const [keys, clients] = await Promise.all([
    db.selectFrom("app_api_keys").select("id").where("id", "in", ids).execute(),
    db.selectFrom("app_oauth_clients").select("id").where("id", "in", ids).execute(),
  ]);
  return [...keys, ...clients].map((r) => r.id).sort();
}

interface AuditRow {
  event_type: string;
  outcome: string;
  organization_id: string | null;
  metadata: unknown;
}

async function auditRows(): Promise<AuditRow[]> {
  return db
    .selectFrom("app_audit_events")
    .select(["event_type", "outcome", "organization_id", "metadata"])
    .where("actor_better_auth_user_id", "=", ACTOR)
    .orderBy("created_at")
    .execute();
}

/** Asserts a single row of that event type and narrows it for the caller. */
function expectOne(rows: AuditRow[], eventType: string): AuditRow {
  const matches = rows.filter((r) => r.event_type === eventType);
  expect(matches, `expected exactly one ${eventType} row`).toHaveLength(1);
  return matches[0] as AuditRow;
}

function metadataOf(row: AuditRow): Record<string, unknown> {
  // `metadata` is jsonb; `pg` parses it to an object, but a driver that hands
  // back the raw text must not make the assertion silently vacuous.
  return typeof row.metadata === "string"
    ? (JSON.parse(row.metadata) as Record<string, unknown>)
    : (row.metadata as Record<string, unknown>);
}

beforeEach(async () => {
  await cleanup();
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("DELETE /api/administrator/organizations/:id (DB-backed, DB-3)", () => {
  it("returns 2xx and records admin.organization.deleted against the real audit FK", async () => {
    const orgId = await newOrg("clean");

    const res = await DELETE(deleteReq(orgId), { params: Promise.resolve({ id: orgId }) });

    // Before DB-3 this was a 500: the post-delete audit INSERT violated
    // app_audit_events_organization_id_fkey and nothing caught it.
    expect(res.status, await res.text()).toBe(200);

    const org = await db
      .selectFrom("app_organizations")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    expect(org).toBeUndefined();

    const deleted = expectOne(await auditRows(), "admin.organization.deleted");
    expect(deleted.outcome).toBe("success");
    // The row was inserted while the org still existed, then detached by the
    // DB-1 SET NULL cascade — so the tenant identity an operator reads back is
    // the one carried in metadata, not the (now null) column.
    expect(deleted.organization_id).toBeNull();
    expect(metadataOf(deleted)).toMatchObject({
      organizationId: orgId,
      slug: `${PREFIX}clean`,
    });
  });

  it("rolls the success audit back when another FK blocks the delete (409, org intact)", async () => {
    const orgId = await newOrg("inuse");
    await db
      .insertInto("app_roles")
      .values({ organization_id: orgId, key: `${PREFIX}r`, name: "DBTest Role" })
      .execute();

    const res = await DELETE(deleteReq(orgId), { params: Promise.resolve({ id: orgId }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "organization_in_use" });

    const org = await db
      .selectFrom("app_organizations")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    expect(org?.id).toBe(orgId);

    const rows = await auditRows();
    // The success row written inside the transaction died with the rollback:
    // nothing may claim a tenant was deleted when it is still there.
    expect(rows.map((r) => r.event_type)).toEqual(["admin.organization.delete_blocked"]);
    const blocked = expectOne(rows, "admin.organization.delete_blocked");
    expect(blocked.outcome).toBe("denied");
    // The org survives, so this row keeps a real tenant link.
    expect(blocked.organization_id).toBe(orgId);
  });

  it("F-98: deletes an org whose API keys and OAuth clients are all revoked, taking them with it", async () => {
    const owner = await credentialOwner();
    const orgId = await newOrg("revoked");
    const otherOrgId = await newOrg("bystander");
    const revoked = [
      await newCredential("api_key", orgId, owner, "revoked"),
      await newCredential("oauth_client", orgId, owner, "revoked"),
    ];
    // Another tenant's revoked credentials are not this delete's to take.
    const bystanders = [
      await newCredential("api_key", otherOrgId, owner, "revoked"),
      await newCredential("oauth_client", otherOrgId, owner, "revoked"),
    ];

    const res = await DELETE(deleteReq(orgId), { params: Promise.resolve({ id: orgId }) });

    // Before F-98 this was 409 organization_in_use, for good: a revoke keeps
    // the row and nothing ever deletes one.
    expect(res.status, await res.text()).toBe(200);
    const org = await db
      .selectFrom("app_organizations")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst();
    expect(org).toBeUndefined();
    expect(await survivingCredentials([...revoked, ...bystanders])).toEqual([...bystanders].sort());
    expectOne(await auditRows(), "admin.organization.deleted");
  });

  it.each([
    ["api_key", "app_api_keys_organization_id_fkey"],
    ["oauth_client", "app_oauth_clients_organization_id_fkey"],
  ] as const)(
    "F-98: an ACTIVE %s still refuses the delete (409), and the revoked ones roll back with it",
    async (kind, constraint) => {
      const owner = await credentialOwner();
      const orgId = await newOrg(`active_${kind}`);
      const active = await newCredential(kind, orgId, owner, "active");
      const revoked = [
        await newCredential("api_key", orgId, owner, "revoked"),
        await newCredential("oauth_client", orgId, owner, "revoked"),
      ];

      const res = await DELETE(deleteReq(orgId), { params: Promise.resolve({ id: orgId }) });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "organization_in_use" });
      const org = await db
        .selectFrom("app_organizations")
        .select("id")
        .where("id", "=", orgId)
        .executeTakeFirst();
      expect(org?.id).toBe(orgId);
      // The revoked rows were deleted inside the transaction the refusal
      // rolled back, so the tenant is exactly as it was.
      expect(await survivingCredentials([active, ...revoked])).toEqual([active, ...revoked].sort());
      const rows = await auditRows();
      expect(rows.map((r) => r.event_type)).toEqual(["admin.organization.delete_blocked"]);
      // The denial names the table still holding the org: what an admin
      // must revoke before the delete can go through.
      expect(metadataOf(expectOne(rows, "admin.organization.delete_blocked"))).toMatchObject({
        reason: "organization_in_use",
        blockedBy: constraint,
      });
    },
  );
});
