import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { countActiveOauthClientsForOrg, provisionMcpAgent } from "@/lib/mcp/registration.server";

/**
 * DB-BACKED test for the MCP self-registration quota (P1-2).
 *
 * `countActiveOauthClientsForOrg` must count ONLY sanctioned agents — an active
 * OAuth client whose bound service account holds an ACTIVE membership in the
 * org. A self-registered agent awaiting approval (`pending_approval` membership)
 * must NOT consume a quota slot; otherwise an unauthenticated attacker could
 * fill an org's quota with junk pending registrations and permanently block
 * legitimate self-registration.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_` and
 * self-clean.
 */
const PREFIX = "__dbtest_mcpquota_";
const createdUserIds: string[] = [];
let orgId: string;
let otherOrgId: string;

async function makeOrg(slug: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest ${slug}`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function provision(
  organizationId: string,
  status: "active" | "pending_approval",
  name: string,
): Promise<void> {
  const p = await provisionMcpAgent({ clientName: `${PREFIX}${name}`, organizationId, status });
  createdUserIds.push(p.appUserId);
}

async function clearAgents(): Promise<void> {
  if (createdUserIds.length === 0) return;
  await db.deleteFrom("app_oauth_clients").where("app_user_id", "in", createdUserIds).execute();
  await db
    .deleteFrom("app_organization_memberships")
    .where("app_user_id", "in", createdUserIds)
    .execute();
  await db.deleteFrom("app_users").where("id", "in", createdUserIds).execute();
  createdUserIds.length = 0;
}

beforeAll(async () => {
  orgId = await makeOrg("main");
  otherOrgId = await makeOrg("other");
});
afterEach(clearAgents);
afterAll(async () => {
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  await pgPool.end();
});

describe("countActiveOauthClientsForOrg (MCP registration quota)", () => {
  it("counts an approved (active-membership) agent but not pending ones", async () => {
    await provision(orgId, "active", "approved");
    await provision(orgId, "pending_approval", "pending-1");
    await provision(orgId, "pending_approval", "pending-2");

    // Two junk pending registrations do NOT consume quota slots.
    expect(await countActiveOauthClientsForOrg(orgId)).toBe(1);
  });

  it("increments once an agent is approved (its membership becomes active)", async () => {
    await provision(orgId, "pending_approval", "will-approve");
    expect(await countActiveOauthClientsForOrg(orgId)).toBe(0);

    // Approval activates the service account's membership (see activateMcpAgent).
    await db
      .updateTable("app_organization_memberships")
      .set({ status: "active" })
      .where("app_user_id", "in", createdUserIds)
      .where("organization_id", "=", orgId)
      .execute();
    await db
      .updateTable("app_users")
      .set({ status: "active" })
      .where("id", "in", createdUserIds)
      .execute();

    expect(await countActiveOauthClientsForOrg(orgId)).toBe(1);
  });

  it("confines the count to the target org (an active agent elsewhere does not count)", async () => {
    await provision(orgId, "active", "here");
    await provision(otherOrgId, "active", "elsewhere");

    expect(await countActiveOauthClientsForOrg(orgId)).toBe(1);
    expect(await countActiveOauthClientsForOrg(otherOrgId)).toBe(1);
  });
});
