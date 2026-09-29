import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SendModule from "@/lib/email/send.server";
import type * as ProvidersModule from "@/lib/email/providers.server";
import type * as MetricsModule from "@/lib/observability/metrics.server";

/**
 * Unit tests for the outbox-first sender (specs.md §35). The DB and
 * provider layers are stubbed; these tests pin the status lifecycle:
 *
 *   - no provider          → row inserted as `logged`, no delivery
 *   - provider succeeds    → `pending` insert, update to `sent`
 *   - provider throws      → row stays `pending`, scheduled for retry, NO throw
 *   - unknown template key → throws (programmer error)
 * plus the review #21 secret-redaction contract (see the last describe), and
 * the bounded inline retries (F-99) and the drain lease (F-101). The retry
 * wait (`node:timers/promises`) is stubbed to return at once and record the
 * delay it was asked for.
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
  /** F-101: how many of the next outbox UPDATEs fail, as a DB hiccup would. */
  failingUpdates: 0,
  /** F-99: the waits the inline retries asked for, in order. */
  sleeps: [] as number[],
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
        return {
          where: () => ({
            execute: async () => {
              if (state.failingUpdates > 0) {
                state.failingUpdates -= 1;
                throw new Error("connection terminated unexpectedly");
              }
              return undefined;
            },
          }),
        };
      },
    }),
  },
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: async (ms: number) => {
    state.sleeps.push(ms);
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

// F-27: the delivery chokepoint logs through these; the real metrics registry
// is used so the counter is asserted as it would be scraped.
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: log.error,
  logger: { warn: log.warn, error: vi.fn(), info: vi.fn() },
}));

let sendAppEmail: typeof SendModule.sendAppEmail;
let metrics: typeof MetricsModule;

beforeEach(async () => {
  state.templateRows = [];
  state.userRow = undefined;
  state.membershipRows = [];
  state.insertedValues = [];
  state.updateSets = [];
  state.failingUpdates = 0;
  state.sleeps = [];
  state.provider = null;
  log.error.mockReset();
  log.warn.mockReset();
  ({ sendAppEmail } = await import("@/lib/email/send.server"));
  metrics = await import("@/lib/observability/metrics.server");
  metrics.__resetMetricsForTests();
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

    // Every inline attempt failed (F-99): the row stays `pending` (inserted
    // that way; the failure does NOT flip it to `failed`) and is scheduled for
    // the outbox worker.
    expect(result.status).toBe("pending");
    const upd = state.updateSets[0]!;
    expect(upd).toMatchObject({ attempts: 3, error: "mailgun 500: boom" });
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
    expect(payload.html).toContain(`href="${RESET_URL.replaceAll("&", "&amp;")}"`);
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

/**
 * F-27: `sendAppEmail` returns a failed delivery as a status, never throws it,
 * so nothing upstream saw it. A sender the provider refuses (the `@localhost`
 * default, an unverified domain) failed every reset, verification and
 * invitation email on attempt 1 with no log line and no metric. Each outcome
 * is now logged and counted where the row is written; the log line carries
 * no recipient and no one-time link.
 */
describe("sendAppEmail — delivery outcomes are logged and counted (F-27)", () => {
  const RECIPIENT = "victim@example.org";
  const RESET_URL = "http://x/reset-password/LiveTok789?callbackURL=%2F";

  async function counter(outcome: string, template: string): Promise<number> {
    const metric = await metrics.outboxDeliveryTotal.get();
    return (
      metric.values.find((v) => v.labels.outcome === outcome && v.labels.template === template)
        ?.value ?? 0
    );
  }

  it("logs a terminal rejection at error level without the recipient or the link", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      // The vendor body echoes the request, as a validation error can.
      deliver: vi
        .fn()
        .mockRejectedValue(
          new EmailDeliveryError(
            "resend",
            403,
            `domain not verified for ${RECIPIENT} ${RESET_URL}`,
          ),
        ),
    };

    const result = await sendAppEmail({
      to: RECIPIENT,
      templateKey: "password_reset",
      variables: { name: "Ada", resetUrl: RESET_URL },
    });

    expect(result.status).toBe("failed");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toBe("email will not be delivered");
    expect(log.error.mock.calls[0]![1]).toMatchObject({
      kind: "email_delivery",
      outcome: "failed",
      reason: "provider_rejected",
      path: "inline",
      outboxId: "outbox-1",
      template: "password_reset",
      provider: "resend",
      attempts: 1,
      providerStatus: 403,
    });
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain(RECIPIENT);
    expect(logged).not.toContain("LiveTok789");
    expect(logged).not.toContain("Reset your password");
    expect(log.warn).not.toHaveBeenCalled();
    expect(await counter("failed", "password_reset")).toBe(1);
  });

  it("logs a transient failure at warn level and counts it as a retry", async () => {
    state.provider = {
      id: "mailgun",
      deliver: vi.fn().mockRejectedValue(new Error(`mailgun 500: ${RECIPIENT}`)),
    };

    const result = await sendAppEmail({
      to: RECIPIENT,
      templateKey: "email_verification",
      variables: { name: RECIPIENT, verifyUrl: "http://x/verify-email?token=LiveTok456" },
    });

    expect(result.status).toBe("pending");
    expect(log.error).not.toHaveBeenCalled();
    // One line for the send, after its inline retries (F-99), not one per attempt.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({
      outcome: "retry",
      reason: "transient",
      template: "email_verification",
      provider: "mailgun",
      attempts: 3,
    });
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain(RECIPIENT);
    expect(logged).not.toContain("LiveTok456");
    expect(await counter("retry", "email_verification")).toBe(1);
  });

  it("covers the administrator test send, which is this same inline attempt", async () => {
    // POST /api/administrator/email/test calls sendAppEmail exactly like this
    // (test_email, the sender's org); its audit row mirrors only the outcome.
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockRejectedValue(new EmailDeliveryError("resend", 401, "bad key")),
    };
    const result = await sendAppEmail({
      to: RECIPIENT,
      templateKey: "test_email",
      organizationId: "org-a",
      variables: { appName: "App", sentBy: "ba-1" },
    });
    expect(result.status).toBe("failed");
    expect(log.error.mock.calls[0]![1]).toMatchObject({
      template: "test_email",
      providerStatus: 401,
      reason: "provider_rejected",
    });
    expect(await counter("failed", "test_email")).toBe(1);
  });

  it("counts a delivered email as `sent` and an outbox-only one as `logged`, without logging", async () => {
    state.provider = {
      id: "resend",
      deliver: vi.fn().mockResolvedValue({ providerMessageId: "m" }),
    };
    await sendAppEmail({
      to: RECIPIENT,
      templateKey: "organization_invitation",
      variables: {
        inviterName: "Ada",
        organizationName: "Org",
        acceptUrl: "http://x/invite?token=t",
      },
    });
    state.provider = null;
    await sendAppEmail({
      to: RECIPIENT,
      templateKey: "organization_invitation",
      variables: {
        inviterName: "Ada",
        organizationName: "Org",
        acceptUrl: "http://x/invite?token=t",
      },
    });
    expect(await counter("sent", "organization_invitation")).toBe(1);
    expect(await counter("logged", "organization_invitation")).toBe(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

/**
 * F-99: on Vercel the drain runs once a day, so a single transient provider
 * error (a 503, a 429, a reset connection) meant a password-reset or
 * verification email that was never delivered: by the next tick its one-hour
 * token was dead and the drain failed the row as `token_expired`. The inline
 * send now retries a TRANSIENT failure a bounded number of times, and a row
 * that still fails stays `pending` for the drain.
 */
describe("sendAppEmail — bounded inline retries (F-99)", () => {
  const input = () => ({
    to: "user@example.com",
    templateKey: "password_reset",
    variables: { name: "Ada", resetUrl: "http://x/reset-password/LiveTok?callbackURL=%2F" },
  });

  it("delivers on a retry after a transient failure, under the same idempotency key", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new EmailDeliveryError("resend", 503, "unavailable"))
      .mockResolvedValueOnce({ providerMessageId: "msg-2" });
    state.provider = { id: "resend", deliver };

    const result = await sendAppEmail(input());

    expect(result).toEqual({ outboxId: "outbox-1", status: "sent" });
    expect(deliver).toHaveBeenCalledTimes(2);
    const keys = deliver.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    // The key is the row id: a retry the provider already saw is deduped (#11).
    expect(keys).toEqual(["outbox-outbox-1", "outbox-outbox-1"]);
    expect(state.sleeps).toHaveLength(1);
    expect(state.updateSets).toHaveLength(1);
    expect(state.updateSets[0]).toMatchObject({
      status: "sent",
      provider_message_id: "msg-2",
      attempts: 2,
      error: null,
      next_attempt_at: null,
      delivery_payload: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("stops after INLINE_MAX_ATTEMPTS and leaves the row claimable by the drain, not failed", async () => {
    const { INLINE_MAX_ATTEMPTS } = await import("@/lib/email/send.server");
    const { backoffDelayMs } = await import("@/lib/email/outbox-worker.server");
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    const deliver = vi.fn().mockRejectedValue(new EmailDeliveryError("resend", 503, "unavailable"));
    state.provider = { id: "resend", deliver };

    const before = Date.now();
    const result = await sendAppEmail(input());

    expect(result.status).toBe("pending");
    expect(deliver).toHaveBeenCalledTimes(INLINE_MAX_ATTEMPTS);
    expect(state.sleeps).toHaveLength(INLINE_MAX_ATTEMPTS - 1);
    const upd = state.updateSets[0]!;
    // Still `pending` (no status written) with the unredacted copy kept, due
    // after the backoff for the attempts already spent.
    expect(upd.status).toBeUndefined();
    expect(upd.delivery_payload).toBeUndefined();
    expect(upd.attempts).toBe(INLINE_MAX_ATTEMPTS);
    const due = (upd.next_attempt_at as Date).getTime();
    expect(due).toBeGreaterThanOrEqual(before + backoffDelayMs(INLINE_MAX_ATTEMPTS));
  });

  it("does not retry a permanent rejection", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    const deliver = vi
      .fn()
      .mockRejectedValue(new EmailDeliveryError("resend", 422, "invalid `to`"));
    state.provider = { id: "resend", deliver };

    const result = await sendAppEmail(input());

    expect(result.status).toBe("failed");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(state.sleeps).toEqual([]);
    expect(state.updateSets[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("waits at least the provider's Retry-After before the next attempt", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new EmailDeliveryError("resend", 429, "rate limited", "3"))
      .mockResolvedValueOnce({ providerMessageId: "m" });
    state.provider = { id: "resend", deliver };

    await sendAppEmail(input());

    expect(state.sleeps).toEqual([3000]);
  });

  it("leaves to the drain a retry whose wait would overrun the budget", async () => {
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    // Come back in a minute: no inline wait may be that long.
    const deliver = vi
      .fn()
      .mockRejectedValue(new EmailDeliveryError("resend", 429, "rate limited", "60"));
    state.provider = { id: "resend", deliver };

    const result = await sendAppEmail(input());

    expect(result.status).toBe("pending");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(state.sleeps).toEqual([]);
    expect(state.updateSets[0]).toMatchObject({ attempts: 1 });
  });

  it("does not retry after an attempt that used up the provider timeout", async () => {
    const { PROVIDER_TIMEOUT_MS } = await import("@/lib/email/providers.server");
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      // A hung provider: the attempt ends at the timeout, and the provider may
      // have accepted it after all. Another whole timeout would not fit.
      const deliver = vi.fn().mockImplementation(async () => {
        clock += PROVIDER_TIMEOUT_MS;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });
      state.provider = { id: "resend", deliver };

      const result = await sendAppEmail(input());

      expect(result.status).toBe("pending");
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(state.sleeps).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it("jitters the wait to 50-100% of a doubling base, never under Retry-After", async () => {
    const { inlineRetryDelayMs } = await import("@/lib/email/send.server");
    const { EmailDeliveryError } = await import("@/lib/email/providers.server");
    const plain = new Error("socket hang up");
    expect(inlineRetryDelayMs(1, plain, () => 0)).toBe(500);
    expect(inlineRetryDelayMs(1, plain, () => 1)).toBe(1000);
    expect(inlineRetryDelayMs(2, plain, () => 0)).toBe(1000);
    expect(inlineRetryDelayMs(2, plain, () => 1)).toBe(2000);
    const limited = new EmailDeliveryError("resend", 429, "slow down", "5");
    expect(inlineRetryDelayMs(1, limited, () => 1)).toBe(5000);
  });

  it("keeps its budget coherent with the drain and the lease", async () => {
    const { INLINE_MAX_ATTEMPTS, INLINE_DELIVERY_BUDGET_MS, INLINE_DELIVERY_LEASE_MS } =
      await import("@/lib/email/send.server");
    const { OUTBOX_MAX_ATTEMPTS } = await import("@/lib/email/outbox-worker.server");
    const { PROVIDER_TIMEOUT_MS } = await import("@/lib/email/providers.server");
    // The drain keeps attempts of its own after the inline ones.
    expect(INLINE_MAX_ATTEMPTS).toBeLessThan(OUTBOX_MAX_ATTEMPTS);
    // A fast failure can be retried at all: the longest first wait (1s) plus
    // a whole provider timeout fits.
    expect(INLINE_DELIVERY_BUDGET_MS).toBeGreaterThanOrEqual(1000 + PROVIDER_TIMEOUT_MS);
    // The lease outlives every inline attempt (F-101).
    expect(INLINE_DELIVERY_LEASE_MS).toBeGreaterThan(INLINE_DELIVERY_BUDGET_MS);
  });
});

/**
 * F-101: the drain claims `pending` rows whose `next_attempt_at` is null or
 * past, and the insert left it null, so a drain could claim a row while the
 * inline send was still delivering it and send the email twice (Mailgun has
 * no idempotency API). The insert now leases the row to the inline send.
 * Separately, a failed UPDATE after a delivered email was caught as a
 * delivery failure, which recorded an error and a backoff on the delivered
 * email; and a failed UPDATE after a failed delivery threw.
 */
describe("sendAppEmail — the inline send holds a lease (F-101)", () => {
  it("inserts a provider-backed row leased past the inline budget", async () => {
    const { INLINE_DELIVERY_LEASE_MS } = await import("@/lib/email/send.server");
    state.provider = { id: "resend", deliver: vi.fn().mockResolvedValue({}) };

    const before = Date.now();
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });

    const lease = state.insertedValues[0]!.next_attempt_at;
    expect(lease).toBeInstanceOf(Date);
    expect((lease as Date).getTime()).toBeGreaterThanOrEqual(before + INLINE_DELIVERY_LEASE_MS);
    // Delivered: the lease is released with the `sent` update.
    expect(state.updateSets[0]).toMatchObject({ status: "sent", next_attempt_at: null });
  });

  it("inserts a `logged` row (no provider) with no lease: nothing will claim it", async () => {
    await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });
    expect(state.insertedValues[0]).toMatchObject({ status: "logged", next_attempt_at: null });
  });

  it("does not treat a failed bookkeeping UPDATE after delivery as a delivery failure", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerMessageId: "m" });
    state.provider = { id: "mailgun", deliver };
    state.failingUpdates = 1;

    const result = await sendAppEmail({
      to: "user@example.com",
      templateKey: "test_email",
      variables: { appName: "App", sentBy: "ba-1" },
    });

    // Delivered once and reported as delivered. No second UPDATE records it
    // as a failed attempt with an error and a backoff: the row keeps its
    // insert-time lease, and the drain re-sends it (same idempotency key)
    // only once that lapses.
    expect(result.status).toBe("sent");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(state.sleeps).toEqual([]);
    expect(state.updateSets).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      "email delivered but its outbox row was not updated",
      expect.objectContaining({ outboxId: "outbox-1", templateKey: "test_email" }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  // The same on the failure path: the provider has answered, so a failed
  // UPDATE is logged and the provider's answer returned with the row's id.
  // Throwing told a caller (the invitation routes, F-104) that nothing was
  // queued, while the leased row was still delivered later by the drain.
  it.each([
    ["a transient failure", 503, "pending"],
    ["a permanent rejection", 422, "failed"],
  ] as const)(
    "reports %s with its outbox id when the row UPDATE fails, instead of throwing",
    async (_label, httpStatus, expected) => {
      const { EmailDeliveryError } = await import("@/lib/email/providers.server");
      state.provider = {
        id: "mailgun",
        deliver: vi.fn().mockRejectedValue(new EmailDeliveryError("mailgun", httpStatus, "no")),
      };
      state.failingUpdates = 1;

      const result = await sendAppEmail({
        to: "user@example.com",
        templateKey: "test_email",
        variables: { appName: "App", sentBy: "ba-1" },
      });

      expect(result).toEqual({ outboxId: "outbox-1", status: expected });
      expect(state.updateSets).toHaveLength(1);
      expect(log.error).toHaveBeenCalledWith(
        "email not delivered and its outbox row was not updated",
        expect.objectContaining({ outboxId: "outbox-1", templateKey: "test_email" }),
      );
    },
  );
});
