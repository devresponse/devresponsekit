import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProvidersModule from "@/lib/email/providers.server";

/**
 * Provider idempotency wiring (audit #11). The outbox is at-least-once, so each
 * send carries a stable key (the outbox row id). Resend must forward it as the
 * native `Idempotency-Key` header; Mailgun (no idempotency API) must ride it as
 * a stable `Message-Id`. `fetch` is stubbed to capture the outbound request.
 */
const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  lastRequest: null as { url: string; init: RequestInit } | null,
}));

vi.mock("@/lib/env", () => ({ getServerEnv: () => state.env }));

let mod: typeof ProvidersModule;

beforeEach(async () => {
  state.lastRequest = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      state.lastRequest = { url, init };
      return new Response(JSON.stringify({ id: "provider-msg-1" }), { status: 200 });
    }),
  );
  mod = await import("@/lib/email/providers.server");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const email = {
  to: "a@b.c",
  from: "f@b.c",
  subject: "s",
  html: "<p>x</p>",
  idempotencyKey: "outbox-123",
};

describe("email providers — idempotency wiring (#11)", () => {
  it("Resend forwards the key as the Idempotency-Key header", async () => {
    state.env = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" };
    const provider = mod.getConfiguredEmailProvider();
    const res = await provider!.deliver(email);
    expect(res.providerMessageId).toBe("provider-msg-1");
    const headers = state.lastRequest!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("outbox-123");
  });

  it("Resend omits the header when no key is given", async () => {
    state.env = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" };
    const provider = mod.getConfiguredEmailProvider();
    await provider!.deliver({ ...email, idempotencyKey: undefined });
    const headers = state.lastRequest!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("Mailgun rides the key as a stable Message-Id header", async () => {
    state.env = {
      EMAIL_PROVIDER: "mailgun",
      MAILGUN_API_KEY: "key",
      MAILGUN_DOMAIN: "mail.example.com",
      MAILGUN_BASE_URL: "https://api.mailgun.net",
    };
    const provider = mod.getConfiguredEmailProvider();
    await provider!.deliver(email);
    const body = String(state.lastRequest!.init.body);
    expect(body).toContain(encodeURIComponent("h:Message-Id"));
    expect(body).toContain(encodeURIComponent("<outbox-123@mail.example.com>"));
  });
});

/**
 * review #219: every failure used to be retried five times on a DAILY cron,
 * so "422 invalid recipient" or "403 unverified sending domain" burned four
 * more days against an answer that cannot change — and kept the row (and its
 * unredacted delivery payload) alive for that whole window.
 */
describe("delivery failure classification (review #219)", () => {
  const PERMANENT = [
    [400, "malformed request"],
    [401, "revoked or wrong API key"],
    [403, "unverified sending domain / suppressed recipient"],
    [404, "wrong endpoint or domain"],
    [413, "payload over the provider cap"],
    [415, "unsupported media type"],
    [422, "invalid recipient"],
  ] as const;

  const TRANSIENT = [
    [408, "request timeout"],
    [409, "idempotency-key race"],
    [425, "too early"],
    [429, "rate limited"],
    [500, "provider fault"],
    [502, "bad gateway"],
    [503, "unavailable"],
  ] as const;

  for (const [status, why] of PERMANENT) {
    it(`treats ${status} (${why}) as terminal`, async () => {
      expect(mod.isRetryableDeliveryStatus(status)).toBe(false);
      expect(mod.isRetryableDeliveryError(new mod.EmailDeliveryError("resend", status, "b"))).toBe(
        false,
      );
    });
  }

  for (const [status, why] of TRANSIENT) {
    it(`treats ${status} (${why}) as retryable`, async () => {
      expect(mod.isRetryableDeliveryStatus(status)).toBe(true);
      expect(mod.isRetryableDeliveryError(new mod.EmailDeliveryError("resend", status, "b"))).toBe(
        true,
      );
    });
  }

  it("keeps an unclassified error retryable — a network reset must not drop mail", () => {
    expect(mod.isRetryableDeliveryError(new Error("fetch failed"))).toBe(true);
    expect(mod.isRetryableDeliveryError(new DOMException("aborted", "TimeoutError"))).toBe(true);
    expect(mod.isRetryableDeliveryError("not even an error")).toBe(true);
  });

  it("Resend throws a classified EmailDeliveryError carrying the status", async () => {
    state.env = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid `to` field", { status: 422 })),
    );
    const provider = mod.getConfiguredEmailProvider();
    await expect(provider!.deliver(email)).rejects.toMatchObject({
      name: "EmailDeliveryError",
      provider: "resend",
      status: 422,
      retryable: false,
    });
  });

  it("Mailgun throws a classified EmailDeliveryError and 429 stays retryable", async () => {
    state.env = {
      EMAIL_PROVIDER: "mailgun",
      MAILGUN_API_KEY: "key",
      MAILGUN_DOMAIN: "mail.example.com",
      MAILGUN_BASE_URL: "https://api.mailgun.net",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429 })),
    );
    const provider = mod.getConfiguredEmailProvider();
    await expect(provider!.deliver(email)).rejects.toMatchObject({
      provider: "mailgun",
      status: 429,
      retryable: true,
    });
  });

  it("keeps the vendor body in the message so the outbox reason stays useful", async () => {
    const err = new mod.EmailDeliveryError("resend", 403, "domain not verified");
    expect(err.message).toBe("resend 403: domain not verified");
  });
});
