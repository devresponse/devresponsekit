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
