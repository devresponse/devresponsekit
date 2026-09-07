import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SendModule from "@/lib/email/send.server";
import type * as ProvidersModule from "@/lib/email/providers.server";

/**
 * Unit tests for the outbox-first sender (specs.md §35). The DB and
 * provider layers are stubbed; these tests pin the status lifecycle:
 *
 *   - no provider          → row inserted as `logged`, no delivery
 *   - provider succeeds    → `pending` insert, update to `sent`
 *   - provider throws      → row stays `pending`, scheduled for retry, NO throw
 *   - unknown template key → throws (programmer error)
 * plus the review #21 secret-redaction contract (see the last describe).
 */
const state = vi.hoisted(() => ({
  templateRows: [] as Array<{
    locale: string;
    subject: string;
    body_html: string;
    body_text: string | null;
  }>,
  userRow: undefined as { preferred_locale: string } | undefined,
  membershipRows: [] as Array<{ organization_id: string }>,
  insertedValues: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  provider: null as null | {
    id: string;
    deliver: (email: unknown) => Promise<{ providerMessageId?: string }>;
  },
}));

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) => {
      const chain = {
        select: () => chain,
        where: () => chain,
        execute: async () => {
          if (table === "app_email_templates") return state.templateRows;
          if (table === "app_organization_memberships") return state.membershipRows;
          return [];
        },
        executeTakeFirst: async () => (table === "app_users" ? state.userRow : undefined),
      };
      return chain;
    },
    insertInto: () => ({
      values: (v: Record<string, unknown>) => {
        state.insertedValues.push(v);
        return {
          returning: () => ({
            executeTakeFirstOrThrow: async () => ({ id: "outbox-1" }),
          }),
        };
      },
    }),
    updateTable: () => ({
      set: (v: Record<string, unknown>) => {
        state.updateSets.push(v);
        return { where: () => ({ execute: async () => undefined }) };
      },
    }),
  },
}));

// Only the provider LOOKUP is stubbed; the real failure classification
// (review #219) decides retryable vs terminal below.
vi.mock("@/lib/email/providers.server", async () => {
  const actual = await vi.importActual<typeof ProvidersModule>("@/lib/email/providers.server");
  return { ...actual, getConfiguredEmailProvider: () => state.provider };
});

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ EMAIL_FROM: "Test <no-reply@test.local>" }),
}));

let sendAppEmail: typeof SendModule.sendAppEmail;

beforeEach(async () => {
  state.templateRows = [];
  state.userRow = undefined;
  state.membershipRows = [];
  state.insertedValues = [];
  state.updateSets = [];
  state.provider = null;
  ({ sendAppEmail } = await import("@/lib/email/send.server"));
});
afterEach(() => vi.resetModules());

describe("sendAppEmail", () => {
  it("records the email as `logged` when no provider is configured", async () => {
    const result = await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: "http://x/reset?token=t" },
    });

    expect(result).toEqual({ outboxId: "outbox-1", status: "logged" });
    expect(state.insertedValues).toHaveLength(1);
    expect(state.insertedValues[0]).toMatchObject({
      template_key: "password_reset",
      to_email: "user@example.com",
      from_email: "Test <no-reply@test.local>",
      status: "logged",
      provider: null,
    });
    expect(state.updateSets).toHaveLength(0);
  });

  it("renders the default template with escaped variables", async () => {
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "<Ada>", resetUrl: "http://x/reset?token=t" },
    });

    const row = state.insertedValues[0]!;
    expect(row.subject).toBe("Reset your password");
    expect(row.body_html).toContain("Hi &lt;Ada&gt;");
    // The stored link is REDACTED (review #21) — the token never lands in
    // an admin-readable column; delivery uses the in-memory rendering.
    expect(row.body_html).toContain('href="http://x/reset?token=[redacted]"');
    expect(row.body_text).toContain("Hi <Ada>");
  });

  it("prefers the editable DB template over the code default", async () => {
    state.templateRows = [
      {
        locale: "en",
        subject: "Custom subject for {{name}}",
        body_html: "<p>custom {{name}}</p>",
        body_text: null,
      },
    ];

    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: "http://x" },
    });

    const row = state.insertedValues[0]!;
    expect(row.subject).toBe("Custom subject for Ada");
    expect(row.body_html).toBe("<p>custom Ada</p>");
    expect(row.body_text).toBeNull();
  });

  it("marks the row `sent` with the provider message id on successful delivery", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "msg-9" });
    state.provider = { id: "resend", deliver };

    const result = await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });

    expect(result.status).toBe("sent");
    expect(state.insertedValues[0]).toMatchObject({ status: "pending", provider: "resend" });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com", from: "Test <no-reply@test.local>" }),
    );
    expect(state.updateSets[0]).toMatchObject({ status: "sent", provider_message_id: "msg-9" });
  });

  it("leaves a failed inline delivery RETRYABLE (pending + scheduled), does NOT throw", async () => {
    state.provider = {
      id: "mailgun",
      deliver: vi.fn().mockRejectedValue(new Error("mailgun 500: boom")),
    };

    const result = await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });

    // Attempt #1 failed: the row stays `pending` (inserted that way; the catch
    // does NOT flip it to `failed`) and is scheduled for the outbox worker.
    expect(result.status).toBe("pending");
    const upd = state.updateSets[0]!;
    expect(upd).toMatchObject({ attempts: 1, error: "mailgun 500: boom" });
    expect(upd.status).toBeUndefined();
    expect(upd.next_attempt_at).toBeInstanceOf(Date);
  });

  it("resolves the recipient locale from the related app user", async () => {
    state.userRow = { preferred_locale: "fr" };
    state.templateRows = [
      { locale: "fr", subject: "FR", body_html: "<p>fr</p>", body_text: null },
      { locale: "en", subject: "EN", body_html: "<p>en</p>", body_text: null },
    ];

    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: "http://x" },
      relatedBetterAuthUserId: "ba-1",
    });

    expect(state.insertedValues[0]).toMatchObject({ subject: "FR" });
  });

  it("throws on an unknown template key (programmer error)", async () => {
    await expect(
      sendAppEmail({ to: "user@example.com", templateKey: "nope", variables: {} }),
    ).rejects.toThrow(/Unknown email template key/);
  });
});

/**
 * ADR-0001 outbox tenant attribution. The org stamped on the outbox row is
 * what later lets an ORG ADMIN read their own org's mail — so getting this
 * resolution right is the whole point of the tenant column.
 */
describe("sendAppEmail — organization attribution", () => {
  it("attributes the row to the related user's org when membership is unambiguous", async () => {
    state.membershipRows = [{ organization_id: "org-a" }];
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: "http://x" },
      relatedBetterAuthUserId: "ba-1",
    });
    expect(state.insertedValues[0]).toMatchObject({ organization_id: "org-a" });
  });

  it("leaves the row org-less (SUPERADMIN-only) when the user belongs to multiple orgs", async () => {
    state.membershipRows = [{ organization_id: "org-a" }, { organization_id: "org-b" }];
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: "http://x" },
      relatedBetterAuthUserId: "ba-1",
    });
    expect(state.insertedValues[0]!.organization_id).toBeNull();
  });

  it("leaves the row org-less when there is no related user to attribute it to", async () => {
    state.membershipRows = [{ organization_id: "org-a" }]; // present, but unused
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });
    expect(state.insertedValues[0]!.organization_id).toBeNull();
  });

  it("honors an explicit organizationId over the related user's membership", async () => {
    state.membershipRows = [{ organization_id: "org-a" }];
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
      relatedBetterAuthUserId: "ba-1",
      organizationId: "org-x",
    });
    expect(state.insertedValues[0]).toMatchObject({ organization_id: "org-x" });
  });

  it("honors an explicit null organizationId (forces a platform/system row)", async () => {
    state.membershipRows = [{ organization_id: "org-a" }];
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
      relatedBetterAuthUserId: "ba-1",
      organizationId: null,
    });
    expect(state.insertedValues[0]!.organization_id).toBeNull();
  });
});

/**
 * Review #21 — one-time tokens never reach an admin-readable column. The
 * stored `subject` / `body_html` / `body_text` / `variables` carry
 * `[redacted]`; the real rendering goes to the provider from memory and,
 * for a retry, lives ONLY in `delivery_payload`, which is cleared on `sent`.
 */
describe("sendAppEmail — secret redaction (review #21)", () => {
  const RESET_URL = "http://x/reset-password/LiveToken123?callbackURL=%2Fen%2Freset-password";

  it("stores a redacted body/variables and the unredacted copy only in delivery_payload", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "msg-1" });
    state.provider = { id: "resend", deliver };

    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: RESET_URL },
    });

    const row = state.insertedValues[0]!;
    // Nothing an admin route can select carries the token…
    for (const column of ["subject", "body_html", "body_text", "variables"] as const) {
      expect(String(row[column])).not.toContain("LiveToken123");
    }
    expect(row.body_html).toContain("/reset-password/[redacted]?callbackURL=");
    expect(row.body_text).toContain("/reset-password/[redacted]?callbackURL=");
    expect(JSON.parse(row.variables as string)).toEqual({
      name: "Ada",
      resetUrl: "http://x/reset-password/[redacted]?callbackURL=%2Fen%2Freset-password",
    });
    // …while the deliverable is kept, unredacted, for the retry worker.
    const payload = JSON.parse(row.delivery_payload as string) as {
      subject: string;
      html: string;
      text: string | null;
    };
    expect(payload.html).toContain(`href="${RESET_URL.replace("&", "&amp;")}"`);
    expect(payload.text).toContain(RESET_URL);
    expect(payload.subject).toBe("Reset your password");

    // The provider received the REAL link, not the placeholder.
    const sent = deliver.mock.calls[0]![0] as { html: string; text?: string };
    expect(sent.text).toContain(RESET_URL);
    expect(sent.html).not.toContain("[redacted]");
    // Delivered → the unredacted copy is dropped with the `sent` update.
    expect(state.updateSets[0]).toMatchObject({ status: "sent", delivery_payload: null });
  });

  it("keeps delivery_payload when the inline attempt fails (the retry needs it)", async () => {
    state.provider = { id: "resend", deliver: vi.fn().mockRejectedValue(new Error("boom")) };

    const result = await sendAppEmail({
      to: "user@example.com",
      templateKey: "email_verification",
      variables: {
        name: "Ada",
        verifyUrl: "http://x/verify-email?token=LiveToken456&callbackURL=%2F",
      },
    });

    expect(result.status).toBe("pending");
    expect(state.insertedValues[0]!.body_text).not.toContain("LiveToken456");
    expect(state.insertedValues[0]!.body_text).toContain("token=[redacted]&callbackURL=");
    expect(state.insertedValues[0]!.delivery_payload).toContain("LiveToken456");
    // The failure update does NOT touch the payload — it is still needed.
    expect(state.updateSets[0]!.delivery_payload).toBeUndefined();
  });

  it("stores no delivery_payload for a secret-free email (nothing was redacted)", async () => {
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });
    const row = state.insertedValues[0]!;
    expect(row.delivery_payload).toBeNull();
    expect(row.body_html).not.toContain("[redacted]");
  });

  it("redacts the invitation accept link with no provider configured (`logged` row)", async () => {
    await sendAppEmail({
      to: "invitee@example.com",
      templateKey: "organization_invitation",
      variables: {
        inviterName: "Ada",
        organizationName: "Org",
        acceptUrl: "http://x/en/invite?token=PlainInviteToken",
      },
    });
    const row = state.insertedValues[0]!;
    expect(row.status).toBe("logged");
    expect(row.body_html).not.toContain("PlainInviteToken");
    expect(row.body_html).toContain("/en/invite?token=[redacted]");
    // A `logged` row is never delivered by the worker, but the DB-only copy
    // is still the developer's/e2e's only record of the real link.
    expect(row.delivery_payload).toContain("PlainInviteToken");
  });
});

/**
 * review #79: subjects interpolate admin- and user-controlled values (an org
 * name, an inviter's display name, a profile name). A `\r\n` inside one is
 * the classic header-injection primitive — it terminates `Subject:` and lets
 * the rest of the value dictate its own headers or start the body.
 */
describe("sendAppEmail — header-bound values are single-line (review #79)", () => {
  const CRLF_NAME = "Ada\r\nBcc: attacker@evil.example\r\nContent-Type: text/html\r\n\r\n<h1>pwned";

  beforeEach(() => {
    state.templateRows = [
      {
        locale: "en",
        subject: "Invitation from {{name}}",
        body_html: "<p>{{name}}</p>",
        body_text: null,
      },
    ];
  });

  it("strips CR/LF from the rendered subject before it is stored OR delivered", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m" });
    state.provider = { id: "resend", deliver };

    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: CRLF_NAME, resetUrl: "http://x" },
    });

    const stored = String(state.insertedValues[0]!.subject);
    const sentSubject = (deliver.mock.calls[0]![0] as { subject: string }).subject;
    for (const subject of [stored, sentSubject]) {
      expect(subject).not.toContain("\r");
      expect(subject).not.toContain("\n");
      // Collapsed onto one line — the injected header text is now inert body
      // text of the subject, not a header of its own.
      expect(subject.startsWith("Invitation from Ada Bcc:")).toBe(true);
    }
    // Row and delivery agree, so the outbox is an honest record of what went out.
    expect(stored).toBe(sentSubject);
  });

  it("strips every other control character and the Unicode line separators", async () => {
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "A\u0000B\tC\u2028D\u2029E\u001bF", resetUrl: "http://x" },
    });
    const subject = String(state.insertedValues[0]!.subject);
    expect(subject).toBe("Invitation from A B C D E F");
    expect(/[\p{Cc}\u2028\u2029]/u.test(subject)).toBe(false);
  });

  it("caps a runaway subject instead of emitting an over-long header line", async () => {
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "x".repeat(5000), resetUrl: "http://x" },
    });
    expect(String(state.insertedValues[0]!.subject).length).toBeLessThanOrEqual(901);
  });

  it("normalises the address fields too", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m" });
    state.provider = { id: "resend", deliver };
    await sendAppEmail({
      to: "user@example.com\r\nBcc: attacker@evil.example",
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: "http://x" },
    });
    const to = (deliver.mock.calls[0]![0] as { to: string }).to;
    expect(to).not.toMatch(/[\r\n]/);
    expect(String(state.insertedValues[0]!.to_email)).toBe(to);
  });

  it("leaves an ordinary subject untouched", async () => {
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "Ada Lovelace", resetUrl: "http://x" },
    });
    expect(state.insertedValues[0]!.subject).toBe("Invitation from Ada Lovelace");
  });
});

/**
 * review #219 / #235: a permanent provider rejection is terminal on attempt 1
 * — and that is what makes `SendAppEmailResult.status === "failed"` reachable
 * at all. Before this the inline path could only ever return `pending`, so the
 * `failed` member (and the admin test route's `=== "failed"` branches) were
 * dead code.
 */
describe("sendAppEmail — permanent rejections are terminal (review #219 / #235)", () => {
  it("returns `failed` and marks the row terminal on a non-retryable 4xx", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      deliver: vi
        .fn()
        .mockRejectedValue(new EmailDeliveryError("resend", 403, "domain not verified")),
    };

    const result = await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });

    expect(result.status).toBe("failed");
    const upd = state.updateSets[0]!;
    expect(upd).toMatchObject({
      status: "failed",
      attempts: 1,
      next_attempt_at: null,
      delivery_payload: null,
      error: "resend 403: domain not verified",
    });
  });

  it("drops the unredacted payload when a token-bearing send fails permanently", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockRejectedValue(new EmailDeliveryError("resend", 422, "invalid `to`")),
    };
    const result = await sendAppEmail({
      to: "user@example.com",
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: "http://x/reset-password/LiveTok?callbackURL=%2F" },
    });
    expect(result.status).toBe("failed");
    expect(state.insertedValues[0]!.delivery_payload).toContain("LiveTok");
    expect(state.updateSets[0]!.delivery_payload).toBeNull();
  });

  it("still keeps a transient 5xx retryable (`pending`, payload preserved)", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockRejectedValue(new EmailDeliveryError("resend", 503, "unavailable")),
    };
    const result = await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });
    expect(result.status).toBe("pending");
    expect(state.updateSets[0]!.status).toBeUndefined();
    expect(state.updateSets[0]!.next_attempt_at).toBeInstanceOf(Date);
  });
});
