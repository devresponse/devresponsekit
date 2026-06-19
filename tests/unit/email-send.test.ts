import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SendModule from "@/lib/email/send.server";

/**
 * Unit tests for the outbox-first sender (specs.md §35). The DB and
 * provider layers are stubbed; these tests pin the status lifecycle:
 *
 *   - no provider          → row inserted as `logged`, no delivery
 *   - provider succeeds    → `pending` insert, update to `sent`
 *   - provider throws      → row stays `pending`, scheduled for retry, NO throw
 *   - unknown template key → throws (programmer error)
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

vi.mock("@/lib/email/providers.server", () => ({
  getConfiguredEmailProvider: () => state.provider,
}));

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
    expect(row.body_html).toContain('href="http://x/reset?token=t"');
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
