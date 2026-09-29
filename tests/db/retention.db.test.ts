import { sql } from "kysely";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pgPool } from "@/db/database";
import {
  failStalePendingOutbox,
  pruneAll,
  pruneExpiredSsoNonces,
  pruneOutbox,
} from "@/lib/retention.server";

/**
 * DB-BACKED proof of the batched outbox retention (F-96). The unit suite
 * stubs the query builder, so only this file shows that the real statements
 * — `delete … where id in (select … limit N)` and the matching UPDATE —
 * parse, bound each batch to N rows, and leave in-flight `pending` mail alone.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use
 * `__dbtest_ret_` and self-clean. Rows are dated a CENTURY back, and every
 * window below is 36500 days (≈ 99.9 years), so the prunes can never touch
 * anyone else's rows in a shared dev database: a 101-year row is due, a
 * 99-year row is not. The SSO handoff-nonce prune (F-84) has no window to
 * widen; it takes every nonce expired over an hour ago, which no one can use
 * any more, so it is harmless there too.
 */
const PREFIX = "__dbtest_ret_";
const WINDOW = 36500;

let seq = 0;
async function outboxRow(status: string, yearsAgo: number): Promise<string> {
  seq += 1;
  const row = await db
    .insertInto("app_outbox")
    .values({
      organization_id: null,
      template_key: "test_email",
      to_email: `${PREFIX}${seq}@dbtest.local`,
      from_email: "no-reply@dbtest.local",
      subject: "s",
      body_html: "<p>x</p>",
      body_text: null,
      variables: JSON.stringify({}),
      status,
      provider: "resend",
      delivery_payload:
        status === "pending" ? JSON.stringify({ subject: "s", html: "<p>live link</p>" }) : null,
      created_at: sql`now() - make_interval(years => ${yearsAgo})`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function fixtures() {
  return db
    .selectFrom("app_outbox")
    .select(["id", "status", "error", "delivery_payload"])
    .where("to_email", "like", `${PREFIX}%`)
    .execute();
}

/** F-84: the app and user every nonce fixture needs (app ids start with a letter). */
const NONCE_APP_ID = "dbtest-ret-nonce-app";

async function cleanup(): Promise<void> {
  await db.deleteFrom("app_outbox").where("to_email", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_sso_handoff_nonces").where("jti", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_enterprise_applications").where("id", "=", NONCE_APP_ID).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
}

beforeEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AUDIT_RETENTION_DAYS;
  delete process.env.OUTBOX_RETENTION_DAYS;
  delete process.env.OUTBOX_MAX_PENDING_DAYS;
});
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("outbox retention, batched (DB-backed, F-96)", () => {
  it("pruneOutbox deletes only aged TERMINAL rows, looping batch by batch", async () => {
    // The young row goes in FIRST, so a subquery that picked rows without the
    // age filter (leaving it to the outer DELETE) would, scanning in insertion
    // order, pick it for the first batch, delete nothing and stop at 0.
    const youngSent = await outboxRow("sent", 99);
    const sent = await outboxRow("sent", 101);
    const failed = await outboxRow("failed", 101);
    const logged = await outboxRow("logged", 101);
    const oldPending = await outboxRow("pending", 101);
    // Batch size 1: three full batches, then an empty one ends the loop.
    expect(await pruneOutbox(WINDOW, 1)).toBe(3);
    const left = (await fixtures()).map((r) => r.id).sort();
    expect(left).toEqual([youngSent, oldPending].sort());
    expect(left).not.toContain(sent);
    expect(left).not.toContain(failed);
    expect(left).not.toContain(logged);
  });

  it("one statement deletes at most batchSize rows (the subquery LIMIT really bounds it)", async () => {
    await outboxRow("sent", 101);
    await outboxRow("sent", 101);
    await outboxRow("sent", 101);
    // Admit exactly one batch: the first deadline check sees 0 (before the
    // epoch-ms deadline of 1), every later one sees the real clock.
    vi.spyOn(Date, "now").mockReturnValueOnce(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await pruneOutbox(WINDOW, 2, 1)).toBe(2);
    expect(await fixtures()).toHaveLength(1);
  });

  it("failStalePendingOutbox fails only aged PENDING rows, drops their payload, in batches", async () => {
    // In-flight row first, for the same reason as the prune test above.
    const inFlight = await outboxRow("pending", 99);
    const orphanA = await outboxRow("pending", 101);
    const orphanB = await outboxRow("pending", 101);
    const oldSent = await outboxRow("sent", 101);
    // Batch size 1: two full batches, then an empty one.
    expect(await failStalePendingOutbox(WINDOW, 1)).toBe(2);
    const byId = new Map((await fixtures()).map((r) => [r.id, r]));
    for (const id of [orphanA, orphanB]) {
      expect(byId.get(id)).toMatchObject({ status: "failed", delivery_payload: null });
      expect(byId.get(id)!.error).toMatch(/^orphaned:/);
    }
    expect(byId.get(inFlight)).toMatchObject({ status: "pending" });
    expect(byId.get(inFlight)!.delivery_payload).not.toBeNull();
    expect(byId.get(oldSent)).toMatchObject({ status: "sent", error: null });
  });

  it("pruneAll sweeps orphans and reclaims them in the same run", async () => {
    process.env.AUDIT_RETENTION_DAYS = "0"; // leave the shared audit table alone
    process.env.OUTBOX_RETENTION_DAYS = String(WINDOW);
    process.env.OUTBOX_MAX_PENDING_DAYS = String(WINDOW);
    await outboxRow("sent", 101);
    await outboxRow("pending", 101);
    const young = await outboxRow("pending", 99);
    const result = await pruneAll();
    expect(result).toMatchObject({ auditEvents: 0, staleOutboxFailed: 1, outbox: 2 });
    expect((await fixtures()).map((r) => r.id)).toEqual([young]);
  });
});

describe("SSO handoff-nonce retention (DB-backed, F-84)", () => {
  it("pruneExpiredSsoNonces deletes only nonces expired over an hour ago, burned or not", async () => {
    const user = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}nonce_user`,
        primary_email: `${PREFIX}nonce_user@dbtest.local`,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("app_enterprise_applications")
      .values({
        id: NONCE_APP_ID,
        organization_id: null,
        label: "DBTest nonce retention",
        origin: `https://${NONCE_APP_ID}.example.com`,
        subdomain: NONCE_APP_ID,
        sso_audience: `devresponse-app:${NONCE_APP_ID}`,
        // Disabled: no launch of it would ever purge these rows.
        status: "disabled",
      })
      .execute();
    const minutes = (n: number) => new Date(Date.now() + n * 60_000);
    const nonces: [jti: string, expiresAt: Date, consumed: boolean][] = [
      [`${PREFIX}old_burned`, minutes(-120), true],
      [`${PREFIX}old_abandoned`, minutes(-61), false],
      [`${PREFIX}recent`, minutes(-59), false],
      [`${PREFIX}live`, minutes(1), false],
    ];
    for (const [jti, expiresAt, consumed] of nonces) {
      await db
        .insertInto("app_sso_handoff_nonces")
        .values({
          jti,
          app_user_id: user.id,
          target_application_id: NONCE_APP_ID,
          expires_at: expiresAt,
          consumed_at: consumed ? new Date() : null,
        })
        .execute();
    }

    // At least these two; a shared database may hold other long-dead nonces,
    // which the prune rightly takes too.
    expect(await pruneExpiredSsoNonces()).toBeGreaterThanOrEqual(2);

    const left = await db
      .selectFrom("app_sso_handoff_nonces")
      .select("jti")
      .where("jti", "like", `${PREFIX}%`)
      .orderBy("jti")
      .execute();
    expect(left.map((r) => r.jti)).toEqual([`${PREFIX}live`, `${PREFIX}recent`]);
  });
});
