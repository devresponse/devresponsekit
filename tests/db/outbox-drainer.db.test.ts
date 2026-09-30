import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProvidersModule from "@/lib/email/providers.server";

/**
 * DB-BACKED test for the P3-8 outbox drainer edges.
 *
 *   Edge A — the claim must filter on the ACTIVE provider, so a row enqueued
 *     for a since-replaced provider is NOT re-sent through the new one (which
 *     would use a `from_email` the new provider may not own).
 *   Edge B — a delivery failure must persist a SHORT, single-line reason in
 *     `app_outbox.error` (admin-visible, org-scoped), never the provider's raw
 *     multi-line response body.
 *   Edge C — a redacted row (review #21) must be delivered from the jsonb
 *     `delivery_payload` (the real link), never from the stored `[redacted]`
 *     body, and the payload must be nulled once the row is `sent`.
 *   F-101 — a row the inline send is still delivering is leased, so a drain
 *     does not claim it and send the email twice.
 *   F-99 — a row whose inline retries all failed stays `pending` for the
 *     drain. The retry wait is stubbed to return at once.
 *   F-100 — such a row for an invitation is delivered only while the
 *     invitation is still pending under the token it carries: one revoked,
 *     resent, accepted or deleted with its org since is failed unsent.
 *
 * Runs `drainOutbox` against real Postgres; only the provider is mocked (the
 * `db` pool is real). Driven by `pnpm test:db`. Fixtures use `__dbtest_`.
 */
const state = vi.hoisted(() => ({
  provider: null as null | {
    id: string;
    deliver: (e: unknown) => Promise<{ providerMessageId?: string }>;
  },
}));

// Only the provider LOOKUP is stubbed; the real failure classification
// (`isRetryableDeliveryError`, review #219) stays in play so the terminal-vs-
// retry decision exercised here is the one that ships.
vi.mock("@/lib/email/providers.server", async (importOriginal) => {
  const actual = await importOriginal<typeof ProvidersModule>();
  return { ...actual, getConfiguredEmailProvider: () => state.provider };
});

vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));

const { db, pgPool } = await import("@/db/database");
const { drainOutbox } = await import("@/lib/email/outbox-worker.server");
const { INLINE_MAX_ATTEMPTS, sendAppEmail } = await import("@/lib/email/send.server");
const { EmailDeliveryError } = await import("@/lib/email/providers.server");
const { createInvitation, regenerateInvitationToken, revokeInvitation, sendInvitationEmail } =
  await import("@/lib/invitations.server");

const PREFIX = "__dbtest_drain_";

async function insertPending(
  provider: string,
  overrides: Partial<{
    body_html: string;
    body_text: string | null;
    delivery_payload: string | null;
  }> = {},
): Promise<string> {
  const row = await db
    .insertInto("app_outbox")
    .values({
      organization_id: null,
      template_key: "test_email",
      to_email: `${PREFIX}${provider}@dbtest.local`,
      from_email: `no-reply-${provider}@dbtest.local`,
      subject: "s",
      body_html: "<p>x</p>",
      body_text: null,
      variables: JSON.stringify({}),
      status: "pending",
      provider,
      next_attempt_at: null, // immediately due
      ...overrides,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function getRow(id: string) {
  return db
    .selectFrom("app_outbox")
    .select(["id", "status", "provider", "attempts", "error", "delivery_payload"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

beforeEach(async () => {
  state.provider = null;
  await db.deleteFrom("app_outbox").where("to_email", "like", `${PREFIX}%`).execute();
});
afterAll(async () => {
  await db.deleteFrom("app_outbox").where("to_email", "like", `${PREFIX}%`).execute();
  // Invitations cascade with their org.
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  await pgPool.end();
});

describe("drainOutbox (DB-backed, P3-8)", () => {
  it("Edge A: claims only rows enqueued for the active provider", async () => {
    const resendId = await insertPending("resend");
    const mailgunId = await insertPending("mailgun");
    state.provider = { id: "resend", deliver: async () => ({ providerMessageId: "m1" }) };

    const result = await drainOutbox(10);

    // Only the active-provider row is claimed and sent.
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect((await getRow(resendId)).status).toBe("sent");
    // The row for the now-inactive provider is left completely untouched —
    // not re-sent through `resend` with mailgun's `from_email`.
    const mailgun = await getRow(mailgunId);
    expect(mailgun.status).toBe("pending");
    expect(mailgun.attempts).toBe(0);
  });

  it("Edge B: persists a short, single-line reason — never the raw provider body", async () => {
    const id = await insertPending("resend");
    // A realistic hostile/verbose provider failure: status prefix + a long,
    // multi-line HTML body (as providers.server embeds via `await res.text()`).
    const rawBody = `resend 500: <!doctype html>\n${"<div>err</div>\n".repeat(400)}`;
    state.provider = {
      id: "resend",
      deliver: async () => {
        throw new Error(rawBody);
      },
    };

    await drainOutbox(10);

    const { error } = await getRow(id);
    expect(error).toBeTruthy();
    expect(error!).not.toContain("\n"); // collapsed to a single line
    expect(error!.length).toBeLessThanOrEqual(201); // 200 chars + the ellipsis
    expect(error!.startsWith("resend 500:")).toBe(true); // useful prefix kept
    expect(error!).not.toContain(rawBody); // the raw body is NOT stored verbatim
  });

  it("Edge C: delivers the unredacted delivery_payload and nulls it once sent (#21)", async () => {
    const live = "http://x/reset-password/LiveDbToken?callbackURL=%2F";
    const id = await insertPending("resend", {
      body_html: '<a href="http://x/reset-password/[redacted]?callbackURL=%2F">Reset</a>',
      body_text: "http://x/reset-password/[redacted]?callbackURL=%2F",
      delivery_payload: JSON.stringify({
        subject: "Reset your password",
        html: `<a href="${live}">Reset</a>`,
        text: live,
      }),
    });
    const delivered: Array<{ subject: string; html: string; text?: string }> = [];
    state.provider = {
      id: "resend",
      deliver: async (e) => {
        delivered.push(e as (typeof delivered)[number]);
        return { providerMessageId: "m-c" };
      },
    };

    const result = await drainOutbox(10);

    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    // The provider got the REAL link (jsonb read back as an object by pg)…
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.subject).toBe("Reset your password");
    expect(delivered[0]!.text).toBe(live);
    expect(delivered[0]!.html).not.toContain("[redacted]");
    // …and the live token is no longer at rest once the row is terminal.
    const row = await getRow(id);
    expect(row.status).toBe("sent");
    expect(row.delivery_payload).toBeNull();
  });
});

/**
 * F-101 / F-99 against real Postgres: the drain's claim query is what must
 * skip a row the inline send is still delivering, so the lease is proved
 * with the real `sendAppEmail` and the real claim, not a stub of either.
 */
describe("sendAppEmail and the drain (DB-backed, F-101 / F-99)", () => {
  const to = `${PREFIX}inline@dbtest.local`;
  const send = () =>
    sendAppEmail({
      to,
      templateKey: "test_email",
      organizationId: null,
      variables: { appName: "App", sentBy: "dbtest" },
    });

  it("F-101: a drain does not claim a row the inline send is still delivering", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inFlight!: () => void;
    const started = new Promise<void>((resolve) => (inFlight = resolve));
    const deliveries: string[] = [];
    state.provider = {
      id: "resend",
      deliver: async (e) => {
        deliveries.push((e as { idempotencyKey: string }).idempotencyKey);
        // Only the first (inline) call waits; a second one is the duplicate.
        if (deliveries.length === 1) {
          inFlight();
          await gate;
        }
        return { providerMessageId: `m-${deliveries.length}` };
      },
    };

    const sending = send();
    await started; // the row is written and the provider call is in flight
    const drained = await drainOutbox(10);
    release();
    const result = await sending;

    expect(drained.claimed).toBe(0);
    expect(deliveries).toHaveLength(1);
    expect(result.status).toBe("sent");
    const row = await getRow(result.outboxId);
    expect(row).toMatchObject({ status: "sent", attempts: 1, error: null });
  });

  it("F-99: a row whose inline retries all failed stays pending, and the drain delivers it", async () => {
    state.provider = {
      id: "resend",
      deliver: async () => {
        throw new EmailDeliveryError("resend", 503, "unavailable");
      },
    };

    const result = await send();

    expect(result.status).toBe("pending");
    const pending = await getRow(result.outboxId);
    expect(pending).toMatchObject({ status: "pending", attempts: INLINE_MAX_ATTEMPTS });
    // Not due yet: the backoff after the inline attempts keeps the drain off it.
    expect((await drainOutbox(10)).claimed).toBe(0);

    // Time passes (the backoff runs out) and the provider recovers.
    await db
      .updateTable("app_outbox")
      .set({ next_attempt_at: new Date(Date.now() - 1000) })
      .where("id", "=", result.outboxId)
      .execute();
    state.provider = { id: "resend", deliver: async () => ({ providerMessageId: "m-drain" }) };

    expect(await drainOutbox(10)).toMatchObject({ claimed: 1, sent: 1 });
    expect(await getRow(result.outboxId)).toMatchObject({
      status: "sent",
      attempts: INLINE_MAX_ATTEMPTS + 1,
      error: null,
    });
  });
});

/**
 * F-100 against real Postgres: the invitation is created, revoked and rotated
 * by the real invitation functions, its email is queued by the real
 * `sendInvitationEmail` while the provider is down (so the row waits for the
 * drain, as in the review's scenario), and the drain's lookup runs its real
 * query over the stored token hashes.
 */
describe("invitation mail after its invitation dies (DB-backed, F-100)", () => {
  const INVITEE = `${PREFIX}invitee@dbtest.local`;
  let orgId: string;
  let delivered: string[];

  beforeEach(async () => {
    await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
    orgId = (
      await db
        .insertInto("app_organizations")
        .values({ slug: `${PREFIX}org`, name: "DBTest Drain Org" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    delivered = [];
  });

  /** Queues the invitation email while the provider is down, then makes the row due. */
  async function queueWhileProviderDown(plaintextToken: string): Promise<string> {
    state.provider = {
      id: "resend",
      deliver: async () => {
        throw new EmailDeliveryError("resend", 503, "unavailable");
      },
    };
    const sent = await sendInvitationEmail({
      to: INVITEE,
      organizationId: orgId,
      organizationName: "DBTest Drain Org",
      inviterAppUserId: null,
      plaintextToken,
      locale: "en",
    });
    expect(sent.status).toBe("pending");
    await db
      .updateTable("app_outbox")
      .set({ next_attempt_at: new Date(Date.now() - 1000) })
      .where("id", "=", sent.outboxId)
      .execute();
    return sent.outboxId;
  }

  /** The provider is back: records the text body of every email it is handed. */
  function providerRecovers(): void {
    state.provider = {
      id: "resend",
      deliver: async (e) => {
        delivered.push((e as { text?: string }).text ?? "");
        return { providerMessageId: `m-${delivered.length}` };
      },
    };
  }

  async function expectSuperseded(outboxId: string): Promise<void> {
    const row = await getRow(outboxId);
    // Failed without an attempt of its own, and the live link is not kept.
    expect(row).toMatchObject({
      status: "failed",
      attempts: INLINE_MAX_ATTEMPTS,
      delivery_payload: null,
    });
    expect(row.error).toMatch(/^invitation_superseded: /);
  }

  it("delivers a still-pending invitation's email, with its live link", async () => {
    const { plaintextToken } = await createInvitation({ organizationId: orgId, email: INVITEE });
    const outboxId = await queueWhileProviderDown(plaintextToken);
    providerRecovers();

    expect(await drainOutbox(10)).toMatchObject({ claimed: 1, sent: 1, superseded: 0 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(`/invite?token=${plaintextToken}`);
    expect((await getRow(outboxId)).status).toBe("sent");
  });

  it.each([
    [
      "revoked",
      async (invitationId: string) => {
        const revoked = await revokeInvitation({
          invitationId,
          organizationId: orgId,
          revokedByBetterAuthUserId: `${PREFIX}admin`,
        });
        expect(revoked).toBe(true);
      },
    ],
    [
      // The state `consumeInvitation`'s guarded flip leaves, set directly: the
      // accept path needs user and inviter fixtures this suite does not own.
      "accepted",
      async (invitationId: string) => {
        await db
          .updateTable("app_organization_invitations")
          .set({ status: "accepted", accepted_at: new Date() })
          .where("id", "=", invitationId)
          .execute();
      },
    ],
    [
      // Invitations cascade with their org; the outbox row survives, org-less.
      "deleted with its organization",
      async () => {
        await db.deleteFrom("app_organizations").where("id", "=", orgId).execute();
      },
    ],
  ])("drops the queued email of an invitation %s since, unsent", async (_, kill) => {
    const { id, plaintextToken } = await createInvitation({
      organizationId: orgId,
      email: INVITEE,
    });
    const outboxId = await queueWhileProviderDown(plaintextToken);
    await kill(id);
    providerRecovers();

    expect(await drainOutbox(10)).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 0,
      superseded: 1,
    });
    expect(delivered).toEqual([]);
    await expectSuperseded(outboxId);
  });

  it("after a resend, delivers only the fresh email and drops the stale one", async () => {
    const { id, plaintextToken: staleToken } = await createInvitation({
      organizationId: orgId,
      email: INVITEE,
    });
    const staleId = await queueWhileProviderDown(staleToken);
    const rotated = await regenerateInvitationToken({ invitationId: id, organizationId: orgId });
    const freshId = await queueWhileProviderDown(rotated!.plaintextToken);
    providerRecovers();

    expect(await drainOutbox(10)).toMatchObject({ claimed: 2, sent: 1, superseded: 1 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(`/invite?token=${rotated!.plaintextToken}`);
    expect(delivered[0]).not.toContain(staleToken);
    expect((await getRow(freshId)).status).toBe("sent");
    await expectSuperseded(staleId);
  });
});
