import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";

/**
 * DB-BACKED test for F-64: the budgets on the mail an administrator sends hold
 * against live Postgres, so every instance shares them.
 *
 *   1. The org's daily budget counts the audit rows of the four mail-sending
 *      admin actions stamped with THAT org in the last 24 hours, and nothing
 *      else: not another event type, not another org, not an older row. At
 *      the limit it answers 429, with `Retry-After` until the oldest counted
 *      mail leaves the window. A caller with cross-org reach is not refused.
 *   2. The per-recipient cooldown is one row in the shared bucket per
 *      recipient: a second mail inside 10 minutes is refused, whoever asks,
 *      and another recipient is unaffected.
 *
 * The unit suite pins the statement's shape and the refusal envelope; this
 * one, what Postgres makes of them. Driven by `pnpm test:db`
 * (vitest.db.config.ts). Fixtures use `__dbtest_f64_`; audit rows are
 * append-only and go through the sanctioned retention GUC.
 */
const auditMock = vi.hoisted(() => vi.fn());
// A 429's sampled `administrator.rate_limited` row is written fire-and-forget,
// so it could land after the cleanup below. This file tests the budgets.
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...a: unknown[]) => auditMock(...a),
}));

const { db, pgPool } = await import("@/db/database");
const budget = await import("@/lib/admin/admin-mail-budget.server");
const { __resetSharedRateLimitForTests } = await import("@/lib/admin/rate-limit-shared.server");

const PREFIX = "__dbtest_f64_";
const RUN = randomUUID().slice(0, 8);
const ACTOR = `${PREFIX}actor_${RUN}`;
const HOUR_MS = 60 * 60 * 1000;

let orgA = "";
let orgB = "";

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "like", `${PREFIX}%`)
      .execute();
  });
  await db.deleteFrom("app_rate_limits").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(tag: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${tag}_${RUN}`, name: `F-64 ${tag}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Writes `count` audit rows of `eventType` for `org`, `agoMs` in the past. */
async function audited(org: string, eventType: string, agoMs: number, count = 1): Promise<void> {
  const at = new Date(Date.now() - agoMs).toISOString();
  for (let i = 0; i < count; i++) {
    await db
      .insertInto("app_audit_events")
      .values({
        event_type: eventType,
        outcome: "success",
        actor_better_auth_user_id: ACTOR,
        organization_id: org,
        metadata: JSON.stringify({}),
        created_at: sql`${at}::timestamptz`,
      })
      .execute();
  }
}

const orgAdminOf = (organizationId: string) => ({
  access: { permissions: ["admin.orgs.update"], organizationId },
  betterAuthUserId: ACTOR,
  requestId: "req-f64",
});
const request = () => ({ headers: new Headers() });

beforeAll(async () => {
  await cleanup();
  orgA = await newOrg("a");
  orgB = await newOrg("b");
});
afterEach(() => __resetSharedRateLimitForTests());
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-64: the org's daily admin-mail budget", () => {
  it("counts only this org's mail events of the last 24 hours, and refuses at the limit", async () => {
    const events = Object.values(budget.ADMIN_MAIL_EVENTS);
    const limit = budget.ORG_ADMIN_MAIL_DAILY_LIMIT;
    // One mail of every kind; the oldest in the window is 23 hours old.
    await audited(orgA, events[0]!, 23 * HOUR_MS);
    for (let i = 1; i < limit - 1; i++) await audited(orgA, events[i % events.length]!, HOUR_MS);
    // Noise the budget must not count.
    await audited(orgA, "admin.organization.invitation_revoked", HOUR_MS, 30);
    await audited(orgA, events[1]!, 25 * HOUR_MS, 30);
    await audited(orgB, events[1]!, HOUR_MS, 30);

    // limit - 1 counted: the next mail is admitted.
    expect(await budget.enforceOrgAdminMailBudget(orgAdminOf(orgA), orgA, request())).toBeNull();

    await audited(orgA, events[2]!, 0);
    const refused = await budget.enforceOrgAdminMailBudget(orgAdminOf(orgA), orgA, request());
    expect(refused?.status).toBe(429);
    expect(await refused?.json()).toMatchObject({ error: "rate_limited" });
    // A slot frees when the 23-hour-old mail leaves the window, in about an hour.
    const retryAfter = Number(refused?.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(HOUR_MS / 1000 - 30);
    expect(retryAfter).toBeLessThanOrEqual(HOUR_MS / 1000);
  });

  it("leaves another org's budget alone", async () => {
    expect(await budget.enforceOrgAdminMailBudget(orgAdminOf(orgB), orgB, request())).toBeNull();
  });

  it("does not refuse a caller with cross-org reach, whose invitations still count", async () => {
    const superadmin = {
      ...orgAdminOf(orgA),
      access: { permissions: ["superuser"], organizationId: orgA },
    };
    expect(await budget.enforceOrgAdminMailBudget(superadmin, orgA, request())).toBeNull();
  });
});

describe("F-64: the per-recipient cooldown", () => {
  const scope = `${PREFIX}resend_${RUN}`;

  it("admits one mail per recipient per 10 minutes, whoever asks", async () => {
    expect(
      await budget.enforceRecipientCooldown(scope, "inv-1", orgAdminOf(orgA), request()),
    ).toBeNull();
    const again = await budget.enforceRecipientCooldown(
      scope,
      "inv-1",
      { ...orgAdminOf(orgA), betterAuthUserId: `${PREFIX}other_${RUN}` },
      request(),
    );
    expect(again?.status).toBe(429);
    const retryAfter = Number(again?.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(590);
    expect(retryAfter).toBeLessThanOrEqual(600);
    // Another recipient has its own token.
    expect(
      await budget.enforceRecipientCooldown(scope, "inv-2", orgAdminOf(orgA), request()),
    ).toBeNull();
  });
});
