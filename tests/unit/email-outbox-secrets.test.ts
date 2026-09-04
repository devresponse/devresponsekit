import { describe, expect, it } from "vitest";
import {
  REDACTED_TOKEN,
  parseOutboxDeliveryPayload,
  redactEmailSecrets,
  redactRenderedEmail,
} from "@/lib/email/outbox-secrets";
import { escapeHtml } from "@/lib/email/templates";

/**
 * Outbox secret redaction (review #21) — the pure rules behind what
 * `sendAppEmail` stores. Each shape of credential-bearing link the kit
 * actually emits must be caught:
 *   - Better Auth reset:        `/reset-password/<token>?callbackURL=…`
 *   - Better Auth verification: `/verify-email?token=<token>&callbackURL=…`
 *   - Organization invitation:  `/invite?token=<token>`
 * in raw text AND inside an entity-escaped HTML body (`&amp;`), while text
 * without a secret passes through untouched.
 */
const RESET = "http://app.local/reset-password/AbC123xyz_-~?callbackURL=%2Fen%2Freset-password";
const VERIFY = "http://app.local/verify-email?token=T0k3n%2Bv&callbackURL=%2Fen";
const INVITE = "http://app.local/en/invite?token=inv-plaintext-token";

describe("redactEmailSecrets", () => {
  it("redacts the reset-link path segment but keeps the callback", () => {
    const out = redactEmailSecrets(`Reset here: ${RESET}`);
    expect(out).toBe(
      `Reset here: http://app.local/reset-password/${REDACTED_TOKEN}?callbackURL=%2Fen%2Freset-password`,
    );
    expect(out).not.toContain("AbC123xyz");
  });

  it("redacts a `token=` query value and keeps the following parameter", () => {
    expect(redactEmailSecrets(VERIFY)).toBe(
      `http://app.local/verify-email?token=${REDACTED_TOKEN}&callbackURL=%2Fen`,
    );
    expect(redactEmailSecrets(INVITE)).toBe(`http://app.local/en/invite?token=${REDACTED_TOKEN}`);
  });

  it("catches links inside an entity-escaped HTML body (&amp; separators, quoted href)", () => {
    const html = `<a href="${escapeHtml(VERIFY)}">Verify</a> <a href="${escapeHtml(RESET)}">Reset</a>`;
    const out = redactEmailSecrets(html);
    expect(out).toBe(
      `<a href="http://app.local/verify-email?token=${REDACTED_TOKEN}&amp;callbackURL=%2Fen">Verify</a> ` +
        `<a href="http://app.local/reset-password/${REDACTED_TOKEN}?callbackURL=%2Fen%2Freset-password">Reset</a>`,
    );
    expect(out).not.toContain("T0k3n");
    expect(out).not.toContain("AbC123xyz");
  });

  it("is idempotent and leaves secret-free text unchanged", () => {
    const plain = "Hi Ada, your test email from App (sent by ba-1). http://app.local/en/app";
    expect(redactEmailSecrets(plain)).toBe(plain);
    const once = redactEmailSecrets(RESET);
    expect(redactEmailSecrets(once)).toBe(once);
  });
});

describe("redactRenderedEmail", () => {
  it("returns a redacted stored copy + variables and flags that a payload is needed", () => {
    const rendered = {
      subject: "Reset your password",
      html: `<p>Hi Ada</p><p><a href="${escapeHtml(RESET)}">Reset</a></p>`,
      text: `Hi Ada\n\n${RESET}\n`,
    };
    const out = redactRenderedEmail(rendered, { name: "Ada", resetUrl: RESET });
    expect(out.redacted).toBe(true);
    expect(out.stored.subject).toBe("Reset your password");
    expect(out.stored.html).not.toContain("AbC123xyz");
    expect(out.stored.html).toContain(`/reset-password/${REDACTED_TOKEN}?`);
    expect(out.stored.text).not.toContain("AbC123xyz");
    expect(out.variables).toEqual({
      name: "Ada",
      resetUrl: `http://app.local/reset-password/${REDACTED_TOKEN}?callbackURL=%2Fen%2Freset-password`,
    });
    // The input is not mutated — the caller still delivers the real message.
    expect(rendered.text).toContain("AbC123xyz");
  });

  it("flags a secret that only appears in a variable (template dropped the placeholder)", () => {
    const out = redactRenderedEmail(
      { subject: "s", html: "<p>custom body without the link</p>", text: null },
      { acceptUrl: INVITE },
    );
    expect(out.redacted).toBe(true);
    expect(out.variables.acceptUrl).toBe(`http://app.local/en/invite?token=${REDACTED_TOKEN}`);
    expect(out.stored.text).toBeNull();
  });

  it("reports nothing to redact for a secret-free email (no delivery payload needed)", () => {
    const rendered = { subject: "Test email", html: "<p>App</p>", text: "App" };
    const out = redactRenderedEmail(rendered, { appName: "App", sentBy: "ba-1" });
    expect(out.redacted).toBe(false);
    expect(out.stored).toEqual(rendered);
    expect(out.variables).toEqual({ appName: "App", sentBy: "ba-1" });
  });
});

describe("parseOutboxDeliveryPayload", () => {
  it("accepts the object `pg` returns for jsonb, and a JSON string", () => {
    const payload = { subject: "s", html: "<p>h</p>", text: null };
    expect(parseOutboxDeliveryPayload(payload)).toEqual(payload);
    expect(parseOutboxDeliveryPayload(JSON.stringify({ ...payload, text: "t" }))).toEqual({
      ...payload,
      text: "t",
    });
  });

  it("returns null for an absent or malformed payload (worker falls back to the stored body)", () => {
    expect(parseOutboxDeliveryPayload(null)).toBeNull();
    expect(parseOutboxDeliveryPayload(undefined)).toBeNull();
    expect(parseOutboxDeliveryPayload("not json")).toBeNull();
    expect(parseOutboxDeliveryPayload({ subject: "s" })).toBeNull();
    expect(parseOutboxDeliveryPayload({ subject: "s", html: "h", text: 5 })).toBeNull();
  });
});
