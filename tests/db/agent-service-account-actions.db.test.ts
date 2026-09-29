import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

/**
 * DB-BACKED test for the Users console on an MCP agent's service account
 * (F-77).
 *
 * `provisionMcpAgent` gives the account a synthesized `mcp-agent:` id and no
 * Better Auth user. The bulk actions that work on the Better Auth user found
 * none, so every ban, unban, soft-delete and restore row failed with
 * `auth_ban_failed` / `auth_unban_failed` and a failure audit row. And
 * `approve` needed only `admin.users.manage`, so bulk-approving the pending
 * sign-ups activated every self-registration among them, while the Agents
 * console's approve needs `admin.clients.manage`.
 *
 * This provisions a real agent and runs the real bulk dispatcher, Better Auth
 * included, the real status core and the real audit writer against Postgres.
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f77_`
 * and clean up after themselves.
 */
const { db, pgPool } = await import("@/db/database");
const { SUPERADMIN_PERMISSION } = await import("@/lib/admin/access-scope.server");
const { executeBulkUserAction } = await import("@/lib/admin/user-actions.server");
const { provisionMcpAgent } = await import("@/lib/mcp/registration.server");

const PREFIX = "__dbtest_f77_";
const RUN = randomUUID().slice(0, 8);
const ALL = { kind: "all" } as const;

const w = { orgId: "", agentId: "", agentBa: "", agentEmail: "" };

async function cleanup(): Promise<void> {
  const orgs = await db
    .selectFrom("app_organizations")
    .select("id")
    .where("slug", "like", `${PREFIX}%`)
    .execute();
  const orgIds = orgs.map((o) => o.id);
  const users =
    orgIds.length === 0
      ? []
      : await db
          .selectFrom("app_organization_memberships")
          .select("app_user_id")
          .where("organization_id", "in", orgIds)
          .execute();
  const userIds = users.map((u) => u.app_user_id);
  // Audit rows are append-only; the sanctioned retention GUC is the only path
  // that may delete them, and they must go before the users they reference.
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where((eb) =>
        eb.or([
          eb("actor_better_auth_user_id", "like", `${PREFIX}%`),
          ...(userIds.length > 0 ? [eb("app_user_id", "in", userIds)] : []),
        ]),
      )
      .execute();
  });
  if (userIds.length > 0) {
    await db.deleteFrom("app_oauth_clients").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  if (orgIds.length > 0) {
    await db.deleteFrom("app_organizations").where("id", "in", orgIds).execute();
  }
}

/** A superadmin batch: the rank guard and the shared-target rule let it through. */
const actor = (mayActivateAgents?: boolean) => ({
  betterAuthUserId: `${PREFIX}actor`,
  request: { headers: new Headers() },
  scope: ALL,
  access: { permissions: [SUPERADMIN_PERMISSION], organizationId: null },
  requestId: `${PREFIX}req`,
  ...(mayActivateAgents === undefined ? {} : { mayActivateAgents }),
});

async function account(): Promise<{ user: string; membership: string }> {
  const user = await db
    .selectFrom("app_users")
    .select("status")
    .where("id", "=", w.agentId)
    .executeTakeFirstOrThrow();
  const membership = await db
    .selectFrom("app_organization_memberships")
    .select("status")
    .where("app_user_id", "=", w.agentId)
    .executeTakeFirstOrThrow();
  return { user: user.status, membership: membership.status };
}

/** The bulk target as the batch reads it: the account's CURRENT status. */
async function target() {
  return {
    appUserId: w.agentId,
    betterAuthUserId: w.agentBa,
    primaryEmail: w.agentEmail,
    status: (await account()).user,
  };
}

async function auditRows(): Promise<
  { event_type: string; outcome: string; reason: string | null }[]
> {
  return db
    .selectFrom("app_audit_events")
    .select(["event_type", "outcome", "reason"])
    .where("app_user_id", "=", w.agentId)
    .execute();
}

async function setStatus(status: "pending_approval" | "deactivated"): Promise<void> {
  await db.updateTable("app_users").set({ status }).where("id", "=", w.agentId).execute();
  await db
    .updateTable("app_organization_memberships")
    .set({ status: status === "deactivated" ? "blocked" : status })
    .where("app_user_id", "=", w.agentId)
    .execute();
}

beforeAll(async () => {
  await cleanup();
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org_${RUN}`, name: "F77 Org", status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  w.orgId = org.id;
  const agent = await provisionMcpAgent({
    clientName: `${PREFIX}agent_${RUN}`,
    organizationId: w.orgId,
    status: "pending_approval",
  });
  w.agentId = agent.appUserId;
  w.agentBa = agent.betterAuthUserId;
  const row = await db
    .selectFrom("app_users")
    .select("primary_email")
    .where("id", "=", w.agentId)
    .executeTakeFirstOrThrow();
  w.agentEmail = row.primary_email;
});

beforeEach(() => setStatus("pending_approval"));

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("an agent service account in a Users-console batch (F-77)", () => {
  it("has no Better Auth user (the premise)", async () => {
    const { rows } = await pgPool.query(`select 1 from "user" where id = $1`, [w.agentBa]);
    expect(rows).toHaveLength(0);
  });

  it.each(["ban", "unban", "soft_delete"] as const)(
    "%s is refused with not_applicable_to_service_account, not a Better Auth failure",
    async (action) => {
      const out = await executeBulkUserAction(action, await target(), actor(true), {
        reason: "junk registration",
      });
      expect(out).toEqual({
        ok: false,
        appUserId: w.agentId,
        error: "not_applicable_to_service_account",
      });
      expect(await account()).toEqual({
        user: "pending_approval",
        membership: "pending_approval",
      });
      expect(await auditRows()).toEqual([]);
    },
  );

  it("restore of an agent the registration reaper expired is refused the same way", async () => {
    await setStatus("deactivated");
    const out = await executeBulkUserAction("restore", await target(), actor(true));
    expect(out).toEqual({
      ok: false,
      appUserId: w.agentId,
      error: "not_applicable_to_service_account",
    });
    expect(await account()).toEqual({ user: "deactivated", membership: "blocked" });
    expect(await auditRows()).toEqual([]);
  });

  it("approve without admin.clients.manage leaves it pending and writes a denied row", async () => {
    const out = await executeBulkUserAction("approve", await target(), actor(false));
    expect(out).toEqual({ ok: false, appUserId: w.agentId, error: "forbidden_agent_activation" });
    expect(await account()).toEqual({ user: "pending_approval", membership: "pending_approval" });
    expect(await auditRows()).toEqual([
      {
        event_type: "admin.user.action_denied",
        outcome: "denied",
        reason: "agent_requires_clients_manage",
      },
    ]);
  });

  it("approve with admin.clients.manage activates it, and block still stops it", async () => {
    expect(await executeBulkUserAction("approve", await target(), actor(true))).toEqual({
      ok: true,
      appUserId: w.agentId,
    });
    expect(await account()).toEqual({ user: "active", membership: "active" });

    // The account-level kill switch works on an agent with no admin.clients.manage.
    expect(await executeBulkUserAction("block", await target(), actor(false))).toEqual({
      ok: true,
      appUserId: w.agentId,
    });
    expect(await account()).toEqual({ user: "blocked", membership: "blocked" });
  });
});
