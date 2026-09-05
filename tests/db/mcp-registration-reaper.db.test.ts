import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { createOauthClient } from "@/lib/api-auth/oauth-clients.server";
import { activateMcpAgent } from "@/lib/mcp/agents.server";
import {
  expireStalePendingMcpRegistrations,
  MCP_EXPIRED_REGISTRATION_REASON,
} from "@/lib/mcp/reaper.server";
import { provisionMcpAgent } from "@/lib/mcp/registration.server";

/**
 * DB-BACKED tests for the stale-registration reaper (review #13, #51).
 *
 * The sweep must expire ONLY self-registered agents still `pending_approval`
 * older than the TTL — user `deactivated` + reason, membership `blocked`,
 * client `revoked` — and must never touch: a fresh pending agent, an approved
 * agent, an already-expired one (idempotent), an admin-created client, or a
 * plain admin-created user that merely sits in `pending_approval`.
 *
 * Driven by `pnpm test:db`. Fixtures use `__dbtest_` and self-clean.
 */
const PREFIX = "__dbtest_mcpreap_";
const createdUserIds: string[] = [];
let orgId: string;

async function provision(status: "active" | "pending_approval", name: string, ageDays = 0) {
  const p = await provisionMcpAgent({
    clientName: `${PREFIX}${name}`,
    organizationId: orgId,
    status,
  });
  createdUserIds.push(p.appUserId);
  if (ageDays > 0) {
    // Backdate the CLIENT row: the reaper measures age from `c.created_at`.
    await db
      .updateTable("app_oauth_clients")
      .set({ created_at: sql`now() - make_interval(days => ${ageDays})` })
      .where("id", "=", p.client.id)
      .execute();
  }
  return p;
}

async function snapshot(appUserId: string) {
  const user = await db
    .selectFrom("app_users")
    .select(["status", "status_reason", "deactivated_reason", "deactivated_at"])
    .where("id", "=", appUserId)
    .executeTakeFirstOrThrow();
  const membership = await db
    .selectFrom("app_organization_memberships")
    .select(["status", "pre_deactivation_status"])
    .where("app_user_id", "=", appUserId)
    .where("source_provider", "=", "mcp")
    .executeTakeFirst();
  const client = await db
    .selectFrom("app_oauth_clients")
    .select(["status", "revoked_at"])
    .where("app_user_id", "=", appUserId)
    .executeTakeFirstOrThrow();
  return { user, membership, client };
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
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org`, name: "DBTest reap", status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  orgId = row.id;
});
afterEach(clearAgents);
afterAll(async () => {
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  await pgPool.end();
});

describe("expireStalePendingMcpRegistrations", () => {
  it("expires a pending self-registration older than the TTL (user, membership, client)", async () => {
    const stale = await provision("pending_approval", "stale", 10);
    const result = await expireStalePendingMcpRegistrations(7);
    expect(result).toEqual({ expired: 1, ttlDays: 7 });

    const after = await snapshot(stale.appUserId);
    expect(after.user.status).toBe("deactivated");
    expect(after.user.status_reason).toBe(MCP_EXPIRED_REGISTRATION_REASON);
    expect(after.user.deactivated_reason).toBe(MCP_EXPIRED_REGISTRATION_REASON);
    expect(after.user.deactivated_at).not.toBeNull();
    expect(after.membership).toMatchObject({
      status: "blocked",
      pre_deactivation_status: "pending_approval",
    });
    expect(after.client.status).toBe("revoked");
    expect(after.client.revoked_at).not.toBeNull();
  });

  it("leaves a pending registration YOUNGER than the TTL alone", async () => {
    const fresh = await provision("pending_approval", "fresh", 3);
    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(0);
    const after = await snapshot(fresh.appUserId);
    expect(after.user.status).toBe("pending_approval");
    expect(after.client.status).toBe("active");
  });

  it("leaves an APPROVED agent alone however old it is", async () => {
    const approved = await provision("active", "approved", 400);
    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(0);
    expect((await snapshot(approved.appUserId)).client.status).toBe("active");
  });

  it("is idempotent — a second pass expires nothing more", async () => {
    await provision("pending_approval", "once", 30);
    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(1);
    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(0);
  });

  it("is disabled by a TTL of 0 (touches nothing)", async () => {
    const stale = await provision("pending_approval", "ttl0", 365);
    expect(await expireStalePendingMcpRegistrations(0)).toEqual({ expired: 0, ttlDays: 0 });
    expect((await snapshot(stale.appUserId)).user.status).toBe("pending_approval");
  });

  it("never touches an admin-created client or a plain pending user (scope guard)", async () => {
    // A human user parked pending_approval by the sign-up policy…
    const human = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}human`,
        primary_email: `${PREFIX}human@example.test`,
        display_name: "human",
        status: "pending_approval",
        preferred_locale: "en",
        created_at: sql`now() - interval '30 days'`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    createdUserIds.push(human.id);
    await db
      .insertInto("app_organization_memberships")
      .values({ organization_id: orgId, app_user_id: human.id, status: "pending_approval" })
      .execute();
    // …and an admin-created client for a pending service user (created_by ≠ app_user_id).
    const admin = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}admin`,
        primary_email: `${PREFIX}admin@example.test`,
        display_name: "admin",
        status: "active",
        preferred_locale: "en",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    createdUserIds.push(admin.id);
    const service = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}service`,
        primary_email: `${PREFIX}service@example.test`,
        display_name: "service",
        status: "pending_approval",
        preferred_locale: "en",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    createdUserIds.push(service.id);
    await db
      .insertInto("app_organization_memberships")
      .values({
        organization_id: orgId,
        app_user_id: service.id,
        status: "pending_approval",
        source_provider: "mcp",
      })
      .execute();
    const adminMade = await createOauthClient({
      name: `${PREFIX}admin-made`,
      scopes: [],
      organizationId: orgId,
      serviceAppUserId: service.id,
      createdByAppUserId: admin.id,
    });
    await db
      .updateTable("app_oauth_clients")
      .set({ created_at: sql`now() - interval '30 days'` })
      .where("id", "=", adminMade.id)
      .execute();

    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(0);
    const humanAfter = await db
      .selectFrom("app_users")
      .select("status")
      .where("id", "=", human.id)
      .executeTakeFirstOrThrow();
    expect(humanAfter.status).toBe("pending_approval");
    expect((await snapshot(service.id)).client.status).toBe("active");
  });

  it("an agent approved before the sweep stays active; one expired first cannot be approved", async () => {
    const approvedFirst = await provision("pending_approval", "approved-first", 30);
    expect(await activateMcpAgent(approvedFirst.appUserId)).toBe(true);
    const expiredFirst = await provision("pending_approval", "expired-first", 30);

    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(1);
    expect((await snapshot(approvedFirst.appUserId)).client.status).toBe("active");

    // The reaper won this row: Approve is a no-op and does not resurrect the
    // membership (review #51 — activation only cascades when the user flipped).
    expect(await activateMcpAgent(expiredFirst.appUserId)).toBe(false);
    const after = await snapshot(expiredFirst.appUserId);
    expect(after.user.status).toBe("deactivated");
    expect(after.membership?.status).toBe("blocked");
  });
});
