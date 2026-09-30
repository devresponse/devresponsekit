import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkerModule from "@/lib/email/outbox-worker.server";
import type * as ProvidersModule from "@/lib/email/providers.server";
import type * as MetricsModule from "@/lib/observability/metrics.server";

/**
 * Outbox retry worker (review D1). DB + provider are stubbed; these pin the
 * claim/deliver/retry lifecycle:
 *   - no provider                  → no-op, no DB work
 *   - due row + delivery ok        → `sent`, next_attempt_at cleared
 *   - due row + delivery fails      → stays `pending`, attempts++, backoff set
 *   - failure at the attempt cap    → terminal `failed`, next_attempt_at null
 * plus the pure backoff schedule and the review #21 contract: a retry
 * delivers the unredacted `delivery_payload` (never the stored, redacted
 * body) and drops it once the row is terminal.
 */
const state = vi.hoisted(() => ({
  dueRow: undefined as Record<string, unknown> | undefined,
  provider: null as null | {
    id: string;
    deliver: (e: unknown) => Promise<{ providerMessageId?: string }>;
  },
  updateSets: [] as Record<string, unknown>[],
  selectCount: 0,
  /** Simulates the claim transaction's COMMIT failing after the callback ran. */
  commitFails: false,
  /** F-100: whether the invitation lookup finds a pending invitation. */
  invitationPending: false,
  /** F-100: the `where` arguments of each invitation lookup. */
  invitationLookups: [] as unknown[][][],
}));

// Only the provider LOOKUP is stubbed: the failure classification
// (`isRetryableDeliveryError`, review #219) is the real implementation, so the
// terminal-vs-retry decision below is the one that ships.
vi.mock("@/lib/email/providers.server", async () => {
  const actual = await vi.importActual<typeof ProvidersModule>("@/lib/email/providers.server");
  return { ...actual, getConfiguredEmailProvider: () => state.provider };
});
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: log.error,
  logger: { warn: log.warn, error: vi.fn(), info: vi.fn() },
}));

function makeTrx() {
  return {
    selectFrom: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "where", "orderBy", "limit", "forUpdate", "skipLocked"]) {
        chain[m] = () => chain;
      }
      // F-100: the invitation an `organization_invitation` row's link opens.
      if (table === "app_organization_invitations") {
        const wheres: unknown[][] = [];
        chain.where = (...args: unknown[]) => {
          wheres.push(args);
          return chain;
        };
        chain.executeTakeFirst = async () => {
          state.invitationLookups.push(wheres);
          return state.invitationPending ? { id: "inv-1" } : undefined;
        };
        return chain;
      }
      // Return the configured due row exactly once, then "no more due rows" so
      // the drainer's loop terminates.
      chain.executeTakeFirst = async () => {
        state.selectCount += 1;
        return state.selectCount === 1 ? state.dueRow : undefined;
      };
      return chain;
    },
    updateTable: () => ({
      set: (v: Record<string, unknown>) => {
        state.updateSets.push(v);
        return { where: () => ({ execute: async () => undefined }) };
      },
    }),
  };
}
vi.mock("@/db/database", () => ({
  db: {
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) => {
        const value = await cb(makeTrx());
        if (state.commitFails) throw new Error("commit failed: connection reset");
        return value;
      },
    }),
  },
}));

let drainOutbox: typeof WorkerModule.drainOutbox;
let backoffDelayMs: typeof WorkerModule.backoffDelayMs;
let summarizeDeliveryError: typeof WorkerModule.summarizeDeliveryError;
let outboxTokenExpired: typeof WorkerModule.outboxTokenExpired;
let OUTBOX_MAX_ATTEMPTS: number;
let metrics: typeof MetricsModule;

const row = (attempts: number) => ({
  id: "o1",
  to_email: "a@b.c",
  from_email: "f@b.c",
  subject: "s",
  body_html: "<p>x</p>",
  body_text: null,
  delivery_payload: null,
  attempts,
  // `test_email` carries no time-limited credential, so the review #90
  // expiry rule never applies to the lifecycle rows above.
  template_key: "test_email",
  created_at: new Date("2026-01-01T00:00:00Z"),
});

/** A redacted row whose real message lives in `delivery_payload` (#21). */
const secretRow = (attempts: number) => ({
  ...row(attempts),
  // A real token-bearing row: `created_at` is NOW, so it is inside the
  // password-reset TTL and the review #90 rule lets it through to delivery.
  template_key: "password_reset",
  created_at: new Date(),
  body_html: '<a href="http://x/reset-password/[redacted]?callbackURL=%2F">Reset</a>',
  body_text: "http://x/reset-password/[redacted]?callbackURL=%2F",
  delivery_payload: {
    subject: "Reset your password",
    html: '<a href="http://x/reset-password/LiveTok?callbackURL=%2F">Reset</a>',
    text: "http://x/reset-password/LiveTok?callbackURL=%2F",
  },
});

beforeEach(async () => {
  state.dueRow = undefined;
  state.provider = null;
  state.updateSets = [];
  state.selectCount = 0;
  state.commitFails = false;
  state.invitationPending = false;
  state.invitationLookups = [];
  log.error.mockReset();
  log.warn.mockReset();
  metrics = await import("@/lib/observability/metrics.server");
  metrics.__resetMetricsForTests();
  ({
    drainOutbox,
    backoffDelayMs,
    summarizeDeliveryError,
    outboxTokenExpired,
    OUTBOX_MAX_ATTEMPTS,
  } = await import("@/lib/email/outbox-worker.server"));
});
afterEach(() => vi.resetModules());

describe("backoffDelayMs", () => {
  it("doubles per attempt and caps at 1 hour", () => {
    expect(backoffDelayMs(1)).toBe(60_000);
    expect(backoffDelayMs(2)).toBe(120_000);
    expect(backoffDelayMs(3)).toBe(240_000);
    expect(backoffDelayMs(100)).toBe(60 * 60_000);
  });
});

describe("summarizeDeliveryError (P3-8)", () => {
  it("returns a short, single-line message unchanged", () => {
    expect(summarizeDeliveryError(new Error("mailgun 500: rejected"))).toBe(
      "mailgun 500: rejected",
    );
  });

  it("collapses a multi-line raw provider body to one line and hard-caps the length", () => {
    const raw = `resend 422: <!doctype html>\n${"<div>x</div>\n".repeat(200)}`;
    const out = summarizeDeliveryError(new Error(raw));
    expect(out).not.toContain("\n"); // not a multi-line dump
    expect(out.length).toBeLessThanOrEqual(201); // 200 + the ellipsis
    expect(out.startsWith("resend 422:")).toBe(true); // useful status prefix kept
    expect(out).not.toBe(raw); // the raw body is dropped
  });

  it("stringifies a non-Error throwable", () => {
    expect(summarizeDeliveryError("plain string failure")).toBe("plain string failure");
  });
});

describe("drainOutbox", () => {
  it("is a no-op when no provider is configured", async () => {
    state.provider = null;
    state.dueRow = row(0);
    expect(await drainOutbox(10)).toEqual({
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      expired: 0,
      superseded: 0,
    });
    expect(state.updateSets).toHaveLength(0);
  });

  it("marks a due row `sent` on successful delivery", async () => {
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockResolvedValue({ providerMessageId: "m1" }),
    };
    state.dueRow = row(0);
    const r = await drainOutbox(10);
    expect(r).toMatchObject({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(state.updateSets[0]).toMatchObject({
      status: "sent",
      provider_message_id: "m1",
      attempts: 1,
      next_attempt_at: null,
    });
  });

  it("passes a stable per-row idempotency key to the provider (#11)", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    state.provider = { id: "resend", deliver };
    state.dueRow = row(0); // row id "o1"
    await drainOutbox(10);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "outbox-o1" }));
  });

  it("keeps a row `pending` with backoff when delivery fails below the cap", async () => {
    state.provider = { id: "resend", deliver: vi.fn().mockRejectedValue(new Error("boom")) };
    state.dueRow = row(0);
    const r = await drainOutbox(10);
    expect(r).toMatchObject({ claimed: 1, retried: 1, sent: 0, failed: 0 });
    const upd = state.updateSets[0]!;
    expect(upd).toMatchObject({ status: "pending", attempts: 1, error: "boom" });
    expect(upd.next_attempt_at).toBeInstanceOf(Date);
  });

  it("marks a row terminally `failed` when the attempt cap is reached", async () => {
    state.provider = { id: "resend", deliver: vi.fn().mockRejectedValue(new Error("boom")) };
    state.dueRow = row(OUTBOX_MAX_ATTEMPTS - 1); // +1 == cap
    const r = await drainOutbox(10);
    expect(r).toMatchObject({ claimed: 1, failed: 1, sent: 0, retried: 0 });
    expect(state.updateSets[0]).toMatchObject({
      status: "failed",
      attempts: OUTBOX_MAX_ATTEMPTS,
      next_attempt_at: null,
    });
  });
});

describe("drainOutbox — redacted rows deliver from delivery_payload (review #21)", () => {
  it("sends the UNREDACTED payload, never the stored `[redacted]` body, then drops it", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    state.provider = { id: "resend", deliver };
    state.dueRow = secretRow(0);

    const r = await drainOutbox(10);

    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    const sent = deliver.mock.calls[0]![0] as { subject: string; html: string; text?: string };
    expect(sent.subject).toBe("Reset your password");
    expect(sent.html).toContain("/reset-password/LiveTok?");
    expect(sent.text).toContain("/reset-password/LiveTok?");
    expect(sent.html).not.toContain("[redacted]");
    // Terminal `sent`: the live token is not kept at rest any longer.
    expect(state.updateSets[0]).toMatchObject({ status: "sent", delivery_payload: null });
  });

  it("keeps the payload across a retryable failure and drops it on the terminal one", async () => {
    state.provider = { id: "resend", deliver: vi.fn().mockRejectedValue(new Error("boom")) };

    state.dueRow = secretRow(0);
    await drainOutbox(10);
    expect(state.updateSets[0]).toMatchObject({ status: "pending" });
    expect(state.updateSets[0]!.delivery_payload).toBeUndefined(); // untouched → still there

    state.updateSets = [];
    state.selectCount = 0;
    state.dueRow = secretRow(OUTBOX_MAX_ATTEMPTS - 1);
    await drainOutbox(10);
    expect(state.updateSets[0]).toMatchObject({ status: "failed", delivery_payload: null });
  });

  it("falls back to the stored body for a row without a payload (pre-0003 or secret-free)", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    state.provider = { id: "resend", deliver };
    state.dueRow = row(0); // delivery_payload: null
    await drainOutbox(10);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "s", html: "<p>x</p>", text: undefined }),
    );
  });
});

/**
 * review #90: the drain runs on a DAILY cron (`vercel.json`: `0 8 * * *`) and
 * a password-reset / verification token lives one hour, so a retried row
 * delivered a link that had been dead for ~23 hours — the recipient gets mail
 * whose button is already broken, which reads as "my account is broken"
 * rather than "nothing was sent". Such a row is now failed WITHOUT an attempt.
 */
describe("outboxTokenExpired (review #90)", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  const plus = (ms: number) => new Date(t0.getTime() + ms);

  it("is false inside the 1h reset / verification window", () => {
    expect(outboxTokenExpired("password_reset", t0, plus(59 * 60_000))).toBe(false);
    expect(outboxTokenExpired("email_verification", t0, plus(59 * 60_000))).toBe(false);
  });

  it("is true once the 1h window has elapsed", () => {
    expect(outboxTokenExpired("password_reset", t0, plus(60 * 60_000))).toBe(true);
    expect(outboxTokenExpired("email_verification", t0, plus(24 * 60 * 60_000))).toBe(true);
  });

  it("uses the 7-day invitation TTL, not the 1h one", () => {
    expect(outboxTokenExpired("organization_invitation", t0, plus(6 * 24 * 60 * 60_000))).toBe(
      false,
    );
    expect(outboxTokenExpired("organization_invitation", t0, plus(8 * 24 * 60 * 60_000))).toBe(
      true,
    );
  });

  it("reads each TTL from the constant the minting side reads too (F-103)", async () => {
    const ttls = await import("@/lib/token-ttls");
    const { TOKEN_TTL_MS_BY_TEMPLATE } = await import("@/lib/email/outbox-worker.server");
    expect(TOKEN_TTL_MS_BY_TEMPLATE).toEqual({
      password_reset: ttls.PASSWORD_RESET_TOKEN_TTL_MS,
      email_verification: ttls.EMAIL_VERIFICATION_TOKEN_TTL_MS,
      organization_invitation: ttls.INVITATION_TTL_MS,
    });
  });

  it("never expires mail that carries no time-limited credential", () => {
    const far = plus(365 * 24 * 60 * 60_000);
    expect(outboxTokenExpired("test_email", t0, far)).toBe(false);
    expect(outboxTokenExpired(null, t0, far)).toBe(false);
    expect(outboxTokenExpired("some_future_template", t0, far)).toBe(false);
  });
});

describe("drainOutbox — expired tokens are never delivered (review #90)", () => {
  it("fails the row terminally WITHOUT calling the provider", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    state.provider = { id: "resend", deliver };
    state.dueRow = {
      ...secretRow(1),
      // Queued yesterday: the reset token inside died 23 hours ago.
      created_at: new Date(Date.now() - 24 * 60 * 60_000),
    };

    const r = await drainOutbox(10);

    expect(deliver).not.toHaveBeenCalled();
    expect(r).toMatchObject({ claimed: 1, sent: 0, retried: 0, failed: 1, expired: 1 });
    const upd = state.updateSets[0]!;
    expect(upd).toMatchObject({ status: "failed", next_attempt_at: null });
    expect(String(upd.error)).toContain("token_expired");
    // Nothing will ever deliver it, so the live token must not stay at rest.
    expect(upd.delivery_payload).toBeNull();
    // No attempt was made against the provider, so the counter is untouched.
    expect(upd.attempts).toBeUndefined();
  });

  it("still delivers a token-bearing row that is inside its window", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    state.provider = { id: "resend", deliver };
    state.dueRow = secretRow(1); // created_at = now
    const r = await drainOutbox(10);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ sent: 1, expired: 0 });
  });
});

/**
 * F-100: an invitation email queued before its invitation was revoked,
 * resent, accepted or deleted used to be delivered at the next drain anyway.
 * The drain now asks whether the link's token still opens a pending
 * invitation. The lookup is stubbed here; tests/db/outbox-drainer.db.test.ts
 * drives it through the real invitation functions and Postgres.
 */
describe("drainOutbox — withdrawn invitations are never delivered (F-100)", () => {
  const LIVE_URL = "http://x/en/invite?token=LiveInvTok";
  const invitationRow = (payload: { html: string; text: string } | null = null) => ({
    ...row(2),
    template_key: "organization_invitation",
    created_at: new Date(),
    body_html: '<a href="http://x/en/invite?token=[redacted]">Accept</a>',
    body_text: "http://x/en/invite?token=[redacted]",
    delivery_payload: {
      subject: "You're invited to join Acme",
      ...(payload ?? { html: `<a href="${LIVE_URL}">Accept</a>`, text: LIVE_URL }),
    },
  });

  it("delivers the row while its token opens a pending invitation, looked up by hash", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    state.provider = { id: "resend", deliver };
    state.invitationPending = true;
    state.dueRow = invitationRow();

    const r = await drainOutbox(10);

    expect(r).toMatchObject({ claimed: 1, sent: 1, superseded: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
    const { hashSecret } = await import("@/lib/api-auth/api-key");
    expect(state.invitationLookups).toEqual([
      [
        ["token_hash", "in", [await hashSecret("LiveInvTok")]],
        ["status", "=", "pending"],
      ],
    ]);
  });

  it("fails the row WITHOUT calling the provider once the invitation is no longer pending", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    state.provider = { id: "resend", deliver };
    state.invitationPending = false;
    state.dueRow = invitationRow();

    const r = await drainOutbox(10);

    expect(deliver).not.toHaveBeenCalled();
    expect(r).toMatchObject({ claimed: 1, sent: 0, failed: 0, expired: 0, superseded: 1 });
    const upd = state.updateSets[0]!;
    expect(upd).toMatchObject({ status: "failed", next_attempt_at: null, delivery_payload: null });
    expect(String(upd.error)).toMatch(/^invitation_superseded: /);
    // No attempt was made against the provider, so the counter is untouched.
    expect(upd.attempts).toBeUndefined();
    // Withdrawn, not lost: counted, but no failure line and no drain summary.
    expect(log.error).not.toHaveBeenCalled();
    const metric = await metrics.outboxDeliveryTotal.get();
    expect(
      metric.values.find(
        (v: { labels: Record<string, unknown> }) =>
          v.labels.outcome === "superseded" && v.labels.template === "organization_invitation",
      )?.value,
    ).toBe(1);
  });

  it("fails an invitation email that carries no link as a logged failure, without a lookup", async () => {
    const deliver = vi.fn();
    state.provider = { id: "resend", deliver };
    state.invitationPending = true;
    state.dueRow = invitationRow({ html: "<p>Join us</p>", text: "Join us" });

    // Not `superseded`: nothing withdrew the invitation, the email itself is
    // broken (a template that lost `{{acceptUrl}}`), so it alarms like any
    // mail that will never be delivered.
    expect(await drainOutbox(10)).toMatchObject({ claimed: 1, failed: 1, superseded: 0 });
    expect(deliver).not.toHaveBeenCalled();
    expect(state.invitationLookups).toHaveLength(0);
    const upd = state.updateSets[0]!;
    expect(upd).toMatchObject({ status: "failed", next_attempt_at: null, delivery_payload: null });
    expect(String(upd.error)).toMatch(/^invitation_link_missing: /);
    expect(upd.attempts).toBeUndefined();
    const line = log.error.mock.calls.find(
      ([, fields]) => (fields as { kind?: string }).kind === "email_delivery",
    );
    expect(line?.[1]).toMatchObject({
      outcome: "failed",
      reason: "invitation_link_missing",
      template: "organization_invitation",
      attempts: 2,
    });
    const metric = await metrics.outboxDeliveryTotal.get();
    expect(
      metric.values.find(
        (v: { labels: Record<string, unknown> }) =>
          v.labels.outcome === "failed" && v.labels.template === "organization_invitation",
      )?.value,
    ).toBe(1);
  });

  it("never consults invitations for another template", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    state.provider = { id: "resend", deliver };
    state.invitationPending = false;
    state.dueRow = secretRow(0);

    expect(await drainOutbox(10)).toMatchObject({ claimed: 1, sent: 1, superseded: 0 });
    expect(state.invitationLookups).toHaveLength(0);
  });
});

describe("drainOutbox — permanent provider rejections fail fast (review #219)", () => {
  it("marks a non-retryable 4xx terminal on the first attempt", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockRejectedValue(new EmailDeliveryError("resend", 422, "invalid `to`")),
    };
    state.dueRow = row(0);

    const r = await drainOutbox(10);

    expect(r).toMatchObject({ claimed: 1, failed: 1, retried: 0, expired: 0 });
    expect(state.updateSets[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      next_attempt_at: null,
      delivery_payload: null,
    });
  });

  it("keeps retrying a 429 below the cap", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockRejectedValue(new EmailDeliveryError("resend", 429, "slow down")),
    };
    state.dueRow = row(0);
    const r = await drainOutbox(10);
    expect(r).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
    expect(state.updateSets[0]).toMatchObject({ status: "pending", attempts: 1 });
  });
});

/**
 * F-27: the worker reports each row it writes through the same chokepoint as
 * the inline attempt, once its claim transaction has committed. Before, a
 * drain logged only a count of dead rows, with no template, provider or
 * status, and a transient failure left no trace at all.
 */
describe("drainOutbox — each outcome is logged and counted (F-27)", () => {
  async function counter(outcome: string, template: string): Promise<number> {
    const metric = await metrics.outboxDeliveryTotal.get();
    // @prometheus-io/client types a two-label sample's `labels` as a union of
    // one-key records (F-113), so read them through a plain record.
    return (
      metric.values.find(
        (v: { labels: Record<string, unknown> }) =>
          v.labels.outcome === outcome && v.labels.template === template,
      )?.value ?? 0
    );
  }

  /** The per-row `email_delivery` lines, without the per-drain summary. */
  const rowErrors = () =>
    log.error.mock.calls.filter(
      ([, fields]) => (fields as { kind?: string }).kind === "email_delivery",
    );

  it("logs a permanent rejection per row, without the recipient or the link", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      deliver: vi
        .fn()
        .mockRejectedValue(new EmailDeliveryError("resend", 422, "invalid `to`: a@b.c LiveTok")),
    };
    state.dueRow = secretRow(0);

    await drainOutbox(10);

    expect(rowErrors()).toHaveLength(1);
    expect(rowErrors()[0]![1]).toMatchObject({
      outcome: "failed",
      reason: "provider_rejected",
      path: "worker",
      outboxId: "o1",
      template: "password_reset",
      provider: "resend",
      attempts: 1,
      providerStatus: 422,
    });
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain("a@b.c");
    expect(logged).not.toContain("LiveTok");
    expect(await counter("failed", "password_reset")).toBe(1);
  });

  it("logs a transient failure at warn level and counts it as a retry", async () => {
    state.provider = { id: "resend", deliver: vi.fn().mockRejectedValue(new Error("boom")) };
    state.dueRow = row(1);

    await drainOutbox(10);

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({
      outcome: "retry",
      path: "worker",
      template: "test_email",
      attempts: 2,
    });
    expect(await counter("retry", "test_email")).toBe(1);
  });

  it("reports the attempt cap as exhausted, not as a provider rejection", async () => {
    state.provider = { id: "resend", deliver: vi.fn().mockRejectedValue(new Error("boom")) };
    state.dueRow = row(OUTBOX_MAX_ATTEMPTS - 1);
    await drainOutbox(10);
    expect(rowErrors()[0]![1]).toMatchObject({
      outcome: "failed",
      reason: "attempts_exhausted",
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
  });

  it("logs and counts an expired row as its own terminal outcome", async () => {
    state.provider = { id: "resend", deliver: vi.fn() };
    state.dueRow = { ...secretRow(1), created_at: new Date(Date.now() - 24 * 60 * 60_000) };
    await drainOutbox(10);
    expect(rowErrors()[0]![1]).toMatchObject({
      outcome: "expired",
      reason: "token_expired",
      attempts: 1,
    });
    expect(await counter("expired", "password_reset")).toBe(1);
  });

  it("counts a delivered row as `sent` without logging it", async () => {
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockResolvedValue({ providerMessageId: "m" }),
    };
    state.dueRow = row(0);
    await drainOutbox(10);
    expect(await counter("sent", "test_email")).toBe(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reports nothing for a row whose write rolled back (it stays pending and is claimed again)", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockRejectedValue(new EmailDeliveryError("resend", 403, "nope")),
    };
    state.dueRow = row(0);
    state.commitFails = true;

    await expect(drainOutbox(10)).rejects.toThrow(/commit failed/);

    expect(rowErrors()).toHaveLength(0);
    expect(await counter("failed", "test_email")).toBe(0);
  });
});
