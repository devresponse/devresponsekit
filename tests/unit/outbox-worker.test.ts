import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkerModule from "@/lib/email/outbox-worker.server";

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
}));

vi.mock("@/lib/email/providers.server", () => ({
  getConfiguredEmailProvider: () => state.provider,
}));
vi.mock("@/lib/observability/logger.server", () => ({ logServerError: vi.fn() }));

function makeTrx() {
  return {
    selectFrom: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "where", "orderBy", "limit", "forUpdate", "skipLocked"]) {
        chain[m] = () => chain;
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
      execute: async (cb: (trx: unknown) => Promise<unknown>) => cb(makeTrx()),
    }),
  },
}));

let drainOutbox: typeof WorkerModule.drainOutbox;
let backoffDelayMs: typeof WorkerModule.backoffDelayMs;
let summarizeDeliveryError: typeof WorkerModule.summarizeDeliveryError;
let OUTBOX_MAX_ATTEMPTS: number;

const row = (attempts: number) => ({
  id: "o1",
  to_email: "a@b.c",
  from_email: "f@b.c",
  subject: "s",
  body_html: "<p>x</p>",
  body_text: null,
  delivery_payload: null,
  attempts,
});

/** A redacted row whose real message lives in `delivery_payload` (#21). */
const secretRow = (attempts: number) => ({
  ...row(attempts),
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
  ({ drainOutbox, backoffDelayMs, summarizeDeliveryError, OUTBOX_MAX_ATTEMPTS } =
    await import("@/lib/email/outbox-worker.server"));
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
    expect(await drainOutbox(10)).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0 });
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
