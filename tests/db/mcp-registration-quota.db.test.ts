import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { createOauthClient } from "@/lib/api-auth/oauth-clients.server";
import {
  countSelfRegisteredMcpClientsForOrg,
  provisionMcpAgent,
  registerMcpAgent,
} from "@/lib/mcp/registration.server";

/**
 * DB-BACKED tests for the MCP self-registration quota (P1-2, review #51).
 *
 * `countSelfRegisteredMcpClientsForOrg` must count ONLY sanctioned
 * SELF-registered agents — an active OAuth client whose creator is its own
 * service user and whose service account holds an ACTIVE `mcp` membership in
 * the org:
 *   - a self-registered agent awaiting approval (`pending_approval`
 *     membership) must NOT consume a quota slot — otherwise an unauthenticated
 *     attacker could fill the quota with junk and block legitimate agents;
 *   - an ADMIN-created client must not consume a slot either — the quota
 *     bounds what the PUBLIC endpoint can create (review #51).
 * `registerMcpAgent` must hold the quota under CONCURRENT registrations: the
 * count + insert run in one transaction under a per-org advisory lock, so
 * N parallel requests against a quota of K admit exactly K (review #51 —
 * the previous route-level count → insert was a TOCTOU).
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

/** A plain (non-agent) active user with an ACTIVE membership in `organizationId`. */
async function makeUser(organizationId: string, name: string): Promise<string> {
  const user = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}${name}-${Date.now()}`,
      primary_email: `${PREFIX}${name}-${Date.now()}@example.test`,
      display_name: name,
      status: "active",
      preferred_locale: "en",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  createdUserIds.push(user.id);
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: organizationId, app_user_id: user.id, status: "active" })
    .execute();
  return user.id;
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

describe("countSelfRegisteredMcpClientsForOrg (MCP registration quota)", () => {
  it("counts an approved (active-membership) agent but not pending ones", async () => {
    await provision(orgId, "active", "approved");
    await provision(orgId, "pending_approval", "pending-1");
    await provision(orgId, "pending_approval", "pending-2");

    // Two junk pending registrations do NOT consume quota slots.
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(1);
  });

  it("increments once an agent is approved (its membership becomes active)", async () => {
    await provision(orgId, "pending_approval", "will-approve");
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(0);

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

    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(1);
  });

  it("confines the count to the target org (an active agent elsewhere does not count)", async () => {
    await provision(orgId, "active", "here");
    await provision(otherOrgId, "active", "elsewhere");

    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(1);
    expect(await countSelfRegisteredMcpClientsForOrg(otherOrgId)).toBe(1);
  });

  it("does NOT count admin-created clients — even for a service user with an `mcp` membership (review #51)", async () => {
    // An admin provisions a client for a service user: created_by ≠ app_user_id.
    const admin = await makeUser(orgId, "admin");
    const service = await makeUser(orgId, "service");
    await createOauthClient({
      name: `${PREFIX}admin-made`,
      scopes: ["account.read"],
      organizationId: orgId,
      serviceAppUserId: service,
      createdByAppUserId: admin,
    });
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(0);

    // Same client, but the service user's active membership is now `mcp`-
    // sourced (e.g. an admin re-homed an agent): still admin-created, still 0.
    await db
      .updateTable("app_organization_memberships")
      .set({ source_provider: "mcp" })
      .where("app_user_id", "=", service)
      .where("organization_id", "=", orgId)
      .execute();
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(0);

    // A genuine self-registration alongside it counts exactly once.
    await provision(orgId, "active", "self");
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(1);
  });

  it("stops counting a revoked self-registered client", async () => {
    await provision(orgId, "active", "revoked-later");
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(1);
    await db
      .updateTable("app_oauth_clients")
      .set({ status: "revoked" })
      .where("app_user_id", "in", createdUserIds)
      .execute();
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(0);
  });
});

describe("registerMcpAgent (atomic quota, review #51)", () => {
  it("refuses once the quota is reached and admits below it", async () => {
    const base = { clientName: `${PREFIX}r`, organizationId: orgId, status: "active" as const };
    const first = await registerMcpAgent({ ...base, maxPerOrg: 1 });
    expect(first.ok).toBe(true);
    if (first.ok) createdUserIds.push(first.agent.appUserId);

    const second = await registerMcpAgent({ ...base, maxPerOrg: 1 });
    expect(second).toEqual({ ok: false, reason: "quota_exceeded" });
    // A refusal leaves NOTHING behind (the transaction did not insert).
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(1);
    const users = await db
      .selectFrom("app_users")
      .select(db.fn.countAll<string>().as("n"))
      .where("display_name", "=", `${PREFIX}r`)
      .executeTakeFirstOrThrow();
    expect(Number(users.n)).toBe(1);
  });

  it("admits EXACTLY the quota under concurrent registrations (advisory lock closes the TOCTOU)", async () => {
    const MAX = 3;
    const ATTEMPTS = 6; // > MAX, ≤ pool size so every transaction can hold a connection
    // `open` mode: each admitted registration is active immediately and counts,
    // which is precisely the case where a race can overshoot the quota.
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) =>
        registerMcpAgent({
          clientName: `${PREFIX}race-${i}`,
          organizationId: orgId,
          status: "active",
          maxPerOrg: MAX,
        }),
      ),
    );
    for (const r of results) if (r.ok) createdUserIds.push(r.agent.appUserId);

    const admitted = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => !r.ok).length;
    expect(admitted).toBe(MAX);
    expect(refused).toBe(ATTEMPTS - MAX);
    // The database agrees: exactly MAX sanctioned clients exist for the org.
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(MAX);
  });

  it("does not serialize registrations across DIFFERENT orgs (the advisory lock is per org)", async () => {
    // Review must-fix: the previous version of this test only asserted that
    // both registrations eventually succeeded, which a GLOBAL lock would also
    // satisfy (it would admit them one after the other). To make the property
    // observable we hold org A's registration lock in an open transaction on
    // a dedicated connection and then race two registrations against it:
    //   - org B must resolve WHILE the lock is held (no cross-org contention);
    //   - org A must stay pending until we release it — the control that
    //     proves this test drives the SAME lock key `registerMcpAgent` takes
    //     (if the key ever drifted, org A would resolve early and fail here).
    const holder = await pgPool.connect();
    const settle = <T>(p: Promise<T>, ms: number): Promise<T | "pending"> =>
      Promise.race([
        p,
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
      ]);
    let orgA: Promise<Awaited<ReturnType<typeof registerMcpAgent>>> | undefined;
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtext('mcp.register'), hashtext($1::text))",
        [orgId],
      );

      orgA = registerMcpAgent({
        clientName: `${PREFIX}org-a`,
        organizationId: orgId,
        status: "active",
        maxPerOrg: 1,
      });
      const orgB = registerMcpAgent({
        clientName: `${PREFIX}org-b`,
        organizationId: otherOrgId,
        status: "active",
        maxPerOrg: 1,
      });

      // Org B completes while org A's lock is still held.
      const b = await settle(orgB, 5_000);
      expect(b).not.toBe("pending");
      if (b !== "pending") {
        expect(b.ok).toBe(true);
        if (b.ok) createdUserIds.push(b.agent.appUserId);
      }
      // ...and org A is genuinely blocked on that lock (the control assertion).
      expect(await settle(orgA, 500)).toBe("pending");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      // Always drain org A's registration so a failed assertion above cannot
      // leak its rows past `afterEach` (a leaked membership would block the
      // org delete in `afterAll` and poison the next run on a shared dev DB).
      // `orgA` is unassigned if `begin` / the lock acquisition threw.
      const a = orgA ? await orgA : undefined;
      if (a?.ok) createdUserIds.push(a.agent.appUserId);
    }

    // Releasing the lock lets org A through; each org holds exactly one slot.
    const a = await orgA;
    expect(a.ok).toBe(true);
    expect(await countSelfRegisteredMcpClientsForOrg(orgId)).toBe(1);
    expect(await countSelfRegisteredMcpClientsForOrg(otherOrgId)).toBe(1);
  });
});
