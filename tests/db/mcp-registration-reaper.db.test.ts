import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { createOauthClient } from "@/lib/api-auth/oauth-clients.server";
import { activateMcpAgent } from "@/lib/mcp/agents.server";
import {
  expireStalePendingMcpRegistrations,
  MCP_EXPIRED_REGISTRATION_REASON,
  type ReapResult,
} from "@/lib/mcp/reaper.server";
import { provisionMcpAgent } from "@/lib/mcp/registration.server";

/**
 * DB-BACKED tests for the stale-registration reaper (review #13, #51, F-75,
 * F-79).
 *
 * The sweep must expire ONLY self-registered agents still `pending_approval`
 * older than the TTL — user `deactivated` + reason, membership `blocked`,
 * client `revoked` — and must never touch: a fresh pending agent, an approved
 * agent, an already-expired one (idempotent), an admin-created client, or a
 * plain admin-created user that merely sits in `pending_approval`. It drains a
 * backlog larger than one batch, stops between batches at a deadline, and
 * skips a row another transaction holds instead of waiting on it (F-75). It
 * writes one `mcp.client.expired` audit row per agent it expired, naming the
 * agent's organization even when an admin revoked the client mid-pass (F-79).
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

/** The reaper's audit rows (F-79) naming any of these service users. */
async function expiredAudits(appUserIds: string[]) {
  return db
    .selectFrom("app_audit_events")
    .select([
      "event_type",
      "outcome",
      "actor_better_auth_user_id",
      "app_user_id",
      "organization_id",
      "reason",
      "metadata",
    ])
    .where("event_type", "=", "mcp.client.expired")
    .where("app_user_id", "in", appUserIds)
    .execute();
}

/** `p`'s outcome, or "pending" if it has not settled within `ms`. */
function settle<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Resolves once another backend is waiting on a lock: the point the reaper's
 * statement has reached the row a test's open transaction holds. Polled, not
 * slept, so the interleaving is the one that actually ran.
 */
async function lockWaiterAppears(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pgPool.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no backend started waiting on a lock within 5s");
}

async function clearAgents(): Promise<void> {
  if (createdUserIds.length === 0) return;
  // The reaper audits what it expires (F-79). Audit rows are append-only; the
  // sanctioned retention GUC removes them, and first, since
  // `app_audit_events.app_user_id` references the users.
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("app_user_id", "in", createdUserIds).execute();
  });
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
    expect(result).toEqual({ expired: 1, ttlDays: 7, drained: true });

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
    const once = await provision("pending_approval", "once", 30);
    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(1);
    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(0);
    expect(await expiredAudits([once.appUserId])).toHaveLength(1);
  });

  it("F-79: audits each agent it expires as mcp.client.expired, and nothing it left alone", async () => {
    const staleA = await provision("pending_approval", "audit-a", 10);
    const staleB = await provision("pending_approval", "audit-b", 20);
    const fresh = await provision("pending_approval", "audit-fresh", 2);
    const approved = await provision("active", "audit-approved", 30);

    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(2);

    const rows = await expiredAudits([
      staleA.appUserId,
      staleB.appUserId,
      fresh.appUserId,
      approved.appUserId,
    ]);
    expect(rows).toHaveLength(2);
    for (const agent of [staleA, staleB]) {
      const row = rows.find((r) => r.app_user_id === agent.appUserId);
      expect(row).toMatchObject({
        event_type: "mcp.client.expired",
        outcome: "success",
        // Nobody acted: the sweep is the system, not a user.
        actor_better_auth_user_id: null,
        organization_id: orgId,
        reason: MCP_EXPIRED_REGISTRATION_REASON,
        metadata: { clientId: agent.client.client_id, clientRowId: agent.client.id, ttlDays: 7 },
      });
    }
  });

  it("F-75: drains a backlog larger than one batch in one pass, auditing every agent", async () => {
    const stale = [];
    for (let i = 0; i < 5; i += 1) stale.push(await provision("pending_approval", `batch-${i}`, 9));
    const fresh = await provision("pending_approval", "batch-fresh", 1);

    // Batches of 2: three that expire something (2, 2, 1), then an empty one.
    expect(await expireStalePendingMcpRegistrations(7, { batchSize: 2 })).toEqual({
      expired: 5,
      ttlDays: 7,
      drained: true,
    });

    for (const agent of stale) {
      const after = await snapshot(agent.appUserId);
      expect(after.user.status).toBe("deactivated");
      expect(after.membership?.status).toBe("blocked");
      expect(after.client.status).toBe("revoked");
    }
    expect((await snapshot(fresh.appUserId)).client.status).toBe("active");
    const rows = await expiredAudits(stale.map((agent) => agent.appUserId));
    expect(rows.map((row) => row.app_user_id).sort()).toEqual(
      stale.map((agent) => agent.appUserId).sort(),
    );
  });

  it("F-75: a pass past its deadline expires ONE batch and leaves the rest to the next pass", async () => {
    const stale = [];
    for (let i = 0; i < 5; i += 1) {
      stale.push(await provision("pending_approval", `deadline-${i}`, 9));
    }
    const ids = stale.map((agent) => agent.appUserId);
    const stillPending = async () =>
      (await db.selectFrom("app_users").select("status").where("id", "in", ids).execute()).filter(
        (row) => row.status === "pending_approval",
      ).length;

    // The batch in hand finishes and is audited; no second batch starts.
    expect(
      await expireStalePendingMcpRegistrations(7, { batchSize: 2, deadline: Date.now() - 1 }),
    ).toEqual({ expired: 2, ttlDays: 7, drained: false });
    expect(await expiredAudits(ids)).toHaveLength(2);
    expect(await stillPending()).toBe(3);

    expect(await expireStalePendingMcpRegistrations(7, { batchSize: 2 })).toEqual({
      expired: 3,
      ttlDays: 7,
      drained: true,
    });
    expect(await expiredAudits(ids)).toHaveLength(5);
    expect(await stillPending()).toBe(0);
  });

  it("F-75: skips an agent another transaction holds instead of waiting on it", async () => {
    const locked = await provision("pending_approval", "locked", 9);
    const free = [
      await provision("pending_approval", "free-0", 9),
      await provision("pending_approval", "free-1", 9),
    ];
    // What a concurrent pass holds for its batch mid-statement (or an admin's
    // Approve before it commits). Without SKIP LOCKED this pass would queue
    // behind it, then lose the row on the pending re-check.
    const holder = await pgPool.connect();
    let pass: Promise<ReapResult> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from app_users where id = $1 for update", [locked.appUserId]);
      pass = expireStalePendingMcpRegistrations(7, { batchSize: 2 });
      expect(await settle(pass, 5_000)).toEqual({ expired: 2, ttlDays: 7, drained: true });
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      // A pass that was waiting (the failure above) finishes before cleanup.
      await pass?.catch(() => undefined);
    }

    expect((await snapshot(locked.appUserId)).user.status).toBe("pending_approval");
    for (const agent of free) {
      expect((await snapshot(agent.appUserId)).user.status).toBe("deactivated");
    }
    // Released, it is the next pass's.
    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(1);
  });

  it("F-79: names the agent's organization when an admin revoked its client mid-pass", async () => {
    const stale = await provision("pending_approval", "race-revoke", 9);
    // An admin's DELETE /mcp-agents/[id], not yet committed when the pass
    // starts: the batch still sees an active client, flips the user, and waits
    // on the client row; once the revoke commits, the pass skips the client.
    const admin = await pgPool.connect();
    let pass: Promise<ReapResult> | undefined;
    try {
      await admin.query("begin");
      await admin.query(
        "update app_oauth_clients set status = 'revoked', revoked_at = now() where id = $1",
        [stale.client.id],
      );
      pass = expireStalePendingMcpRegistrations(7);
      await lockWaiterAppears();
      await admin.query("commit");
    } finally {
      await admin.query("rollback").catch(() => undefined);
      admin.release();
    }

    expect(await pass).toEqual({ expired: 1, ttlDays: 7, drained: true });
    const rows = await expiredAudits([stale.appUserId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Not null: an org admin's audit view filters on it (ADR-0001).
      organization_id: orgId,
      metadata: { clientId: null, clientRowId: null, ttlDays: 7 },
    });
  });

  it("is disabled by a TTL of 0 (touches nothing)", async () => {
    const stale = await provision("pending_approval", "ttl0", 365);
    expect(await expireStalePendingMcpRegistrations(0)).toEqual({
      expired: 0,
      ttlDays: 0,
      drained: true,
    });
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
