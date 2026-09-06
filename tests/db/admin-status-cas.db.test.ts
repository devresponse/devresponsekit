import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { performAdminStatusChange } from "@/lib/admin-status.server";

/**
 * DB-BACKED proof of the `If-Match` compare-and-swap (review #44).
 *
 * The v1 status route used to READ `updated_at`, compare it to the caller's
 * `If-Match` in application code, and then write unconditionally — a
 * check-then-act. Two writers who read the same version therefore BOTH passed
 * the precondition and BOTH wrote, so the second silently clobbered the first
 * while each was told it had won. No mock can demonstrate that: the race lives
 * in Postgres' concurrency semantics, so this suite drives two genuinely
 * concurrent transactions against a REAL database on separate pool
 * connections and asserts exactly one commits.
 *
 * Run by `pnpm test:db` (vitest.db.config.ts). Fixtures use a `__castest_`
 * prefix and are torn down here, so the suite leaves no residue.
 */
const PREFIX = "__castest_";

/**
 * Audit rows are append-only by trigger; the ONLY sanctioned removal is the
 * retention path (owner + `app.audit_retention = 'on'`), which the sibling
 * suites use for their own fixtures. They must go first: `app_audit_events
 * .app_user_id` is RI-checked on every `app_users` delete.
 */
async function purgeAuditRows(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("app_user_id", "in", (eb) =>
        eb.selectFrom("app_users").select("id").where("better_auth_user_id", "like", `${PREFIX}%`),
      )
      .execute();
  });
}

async function cleanup(): Promise<void> {
  await purgeAuditRows();
  await db
    .deleteFrom("app_organization_memberships")
    .where("app_user_id", "in", (eb) =>
      eb.selectFrom("app_users").select("id").where("better_auth_user_id", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

let orgId = "";
let targetId = "";

async function currentRow(): Promise<{
  status: string;
  updated_at: Date;
  status_reason: string | null;
}> {
  const row = await db
    .selectFrom("app_users")
    .select(["status", "updated_at", "status_reason"])
    .where("id", "=", targetId)
    .executeTakeFirstOrThrow();
  return row as unknown as { status: string; updated_at: Date; status_reason: string | null };
}

beforeAll(async () => {
  await cleanup();
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org`, name: "CAS Test Org" })
    .returning("id")
    .executeTakeFirstOrThrow();
  orgId = org.id;
});

beforeEach(async () => {
  await purgeAuditRows();
  await db
    .deleteFrom("app_organization_memberships")
    .where("app_user_id", "in", (eb) =>
      eb.selectFrom("app_users").select("id").where("better_auth_user_id", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();

  const user = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}ba_target`,
      primary_email: `${PREFIX}target@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  targetId = user.id;
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: orgId, app_user_id: targetId, status: "active" })
    .execute();
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

const SUPER = { kind: "all" } as const;

describe("review #44: If-Match is a compare-and-swap, not check-then-act", () => {
  it("lets exactly ONE of two concurrent writers on the same version win", async () => {
    const before = await currentRow();
    // Both callers read the SAME row and therefore hold the SAME ETag — the
    // exact situation the old check-then-act could not adjudicate.
    const expectedUpdatedAt = before.updated_at;

    const [blockRes, suspendRes] = await Promise.all([
      performAdminStatusChange({
        actorBetterAuthUserId: `${PREFIX}actor_a`,
        scope: SUPER,
        targetAppUserId: targetId,
        newStatus: "blocked",
        newMembershipStatus: "blocked",
        eventType: "admin.user.blocked",
        reason: "writer-a",
        expectedUpdatedAt,
      }),
      performAdminStatusChange({
        actorBetterAuthUserId: `${PREFIX}actor_b`,
        scope: SUPER,
        targetAppUserId: targetId,
        newStatus: "suspended",
        newMembershipStatus: "suspended",
        eventType: "admin.user.suspended",
        reason: "writer-b",
        expectedUpdatedAt,
      }),
    ]);

    const results = [blockRes, suspendRes];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ ok: false, error: "precondition_failed" });

    // The persisted row is the WINNER's, not a blend of the two, and the
    // loser's transaction rolled back whole: its reason never landed.
    const after = await currentRow();
    const winnerStatus = (winners[0] as { ok: true; status: string }).status;
    expect(after.status).toBe(winnerStatus);
    expect(after.status_reason).toBe(winnerStatus === "blocked" ? "writer-a" : "writer-b");
    expect(after.updated_at.getTime()).toBeGreaterThan(expectedUpdatedAt.getTime());

    // Exactly one audit row: the loser must not claim an action it never took.
    const audits = await db
      .selectFrom("app_audit_events")
      .select(["event_type", "outcome"])
      .where("app_user_id", "=", targetId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("success");
  });

  it("rejects a write whose expected version is already stale", async () => {
    const stale = (await currentRow()).updated_at;
    const first = await performAdminStatusChange({
      actorBetterAuthUserId: `${PREFIX}actor_a`,
      scope: SUPER,
      targetAppUserId: targetId,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
      expectedUpdatedAt: stale,
    });
    expect(first.ok).toBe(true);

    const second = await performAdminStatusChange({
      actorBetterAuthUserId: `${PREFIX}actor_b`,
      scope: SUPER,
      targetAppUserId: targetId,
      newStatus: "active",
      newMembershipStatus: "active",
      eventType: "admin.user.reactivated",
      expectedUpdatedAt: stale,
    });
    expect(second).toEqual({ ok: false, error: "precondition_failed" });
    expect((await currentRow()).status).toBe("blocked");
  });

  it("accepts the version it just read (the ms-truncated ETag still matches)", async () => {
    // `updated_at` is a microsecond-precision `timestamptz` that reaches us as
    // a millisecond `Date`; an exact equality predicate would therefore never
    // match and every If-Match write would 412. The CAS compares at the same
    // millisecond granularity the ETag publishes, so the happy path works.
    const { updated_at } = await currentRow();
    const res = await performAdminStatusChange({
      actorBetterAuthUserId: `${PREFIX}actor_a`,
      scope: SUPER,
      targetAppUserId: targetId,
      newStatus: "suspended",
      newMembershipStatus: "suspended",
      eventType: "admin.user.suspended",
      expectedUpdatedAt: updated_at,
    });
    expect(res).toEqual({ ok: true, status: "suspended" });
  });

  it("without an expected version, stays last-write-wins (unchanged behaviour)", async () => {
    const res = await performAdminStatusChange({
      actorBetterAuthUserId: `${PREFIX}actor_a`,
      scope: SUPER,
      targetAppUserId: targetId,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
    });
    expect(res).toEqual({ ok: true, status: "blocked" });
    const second = await performAdminStatusChange({
      actorBetterAuthUserId: `${PREFIX}actor_b`,
      scope: SUPER,
      targetAppUserId: targetId,
      newStatus: "active",
      newMembershipStatus: "active",
      eventType: "admin.user.reactivated",
    });
    expect(second).toEqual({ ok: true, status: "active" });
  });
});
