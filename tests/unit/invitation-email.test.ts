import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportedLocale } from "@/config/i18n-config";
import { sendInvitationEmail } from "@/lib/invitations.server";

/**
 * Unit tests for `sendInvitationEmail` (item B: extracted from the create +
 * resend routes). Covers the inviter-name resolution (display name → email →
 * generic fallback) and the outbox-first `sendAppEmail` call the routes now
 * delegate to. The DB and email sender are stubbed.
 */

const sendAppEmailMock = vi.fn();
vi.mock("@/lib/email/send.server", () => ({
  sendAppEmail: (...a: unknown[]) => sendAppEmailMock(...a),
}));

let inviterRow: { display_name: string | null; primary_email: string } | undefined;
const inviterSelect = vi.fn();
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: () => {
            inviterSelect();
            return Promise.resolve(inviterRow);
          },
        }),
      }),
    }),
  },
}));

beforeEach(() => {
  sendAppEmailMock.mockReset();
  sendAppEmailMock.mockResolvedValue({ outboxId: "out-1", status: "logged" });
  inviterSelect.mockReset();
  inviterRow = undefined;
});
afterEach(() => vi.resetModules());

describe("sendInvitationEmail", () => {
  it("uses the inviter display name and renders the accept link from the token", async () => {
    inviterRow = { display_name: "Admin Ada", primary_email: "ada@x.com" };
    await sendInvitationEmail({
      to: "invitee@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      inviterAppUserId: "admin-1",
      plaintextToken: "tok-abc",
      locale: "en",
    });
    expect(inviterSelect).toHaveBeenCalledTimes(1);
    expect(sendAppEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendAppEmailMock.mock.calls[0]![0] as {
      to: string;
      templateKey: string;
      organizationId?: string | null;
      variables: { inviterName: string; organizationName: string; acceptUrl: string };
    };
    expect(arg.to).toBe("invitee@example.com");
    expect(arg.templateKey).toBe("organization_invitation");
    expect(arg.variables.inviterName).toBe("Admin Ada");
    expect(arg.variables.organizationName).toBe("Acme");
    expect(arg.variables.acceptUrl).toContain("/en/invite?token=tok-abc");
  });

  // F-104: the routes answer and audit with this, so it must not be dropped.
  it("returns what became of the email", async () => {
    sendAppEmailMock.mockResolvedValue({ outboxId: "out-9", status: "failed" });
    const result = await sendInvitationEmail({
      to: "invitee@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      inviterAppUserId: null,
      plaintextToken: "tok",
      locale: "en",
    });
    expect(result).toEqual({ outboxId: "out-9", status: "failed" });
  });

  // review #220: without an explicit `organizationId`, `sendAppEmail` falls
  // back to resolving the org from `relatedBetterAuthUserId` — which an
  // invitation never has (the invitee has no account yet) — so the row landed
  // org-less and SUPERADMIN-only, invisible to the admins who sent it.
  it("attributes the outbox row to the inviting organization", async () => {
    inviterRow = { display_name: "Admin Ada", primary_email: "ada@x.com" };
    await sendInvitationEmail({
      to: "invitee@example.com",
      organizationId: "org-42",
      organizationName: "Acme",
      inviterAppUserId: "admin-1",
      plaintextToken: "tok",
      locale: "en",
    });
    const arg = sendAppEmailMock.mock.calls[0]![0] as {
      organizationId?: string | null;
      relatedBetterAuthUserId?: string;
    };
    expect(arg.organizationId).toBe("org-42");
    // Nothing else may widen the attribution: the invitee has no account, so
    // there is no related user to resolve an org from.
    expect(arg.relatedBetterAuthUserId).toBeUndefined();
  });

  // F-35 review: the email is rendered in the locale it states explicitly, and
  // the accept link is anchored to that same locale. Before, the body relied on
  // `sendAppEmail`'s fallback while the link hard-coded `/en`. They matched only
  // by coincidence, and the comment claiming they matched was not enforced.
  // F-102: that locale is the one the route resolved (`adminMailLocale`), not
  // the default: every invitation went out in English with an `/en/` link.
  it.each<SupportedLocale>(["ja", "uk"])(
    "renders the email in %s and anchors its accept link to it",
    async (locale) => {
      await sendInvitationEmail({
        to: "invitee@example.com",
        organizationId: "org-1",
        organizationName: "Acme",
        inviterAppUserId: null,
        plaintextToken: "tok",
        locale,
      });
      const arg = sendAppEmailMock.mock.calls[0]![0] as {
        locale?: string;
        variables: { acceptUrl: string };
      };
      expect(arg.locale).toBe(locale);
      const url = new URL(arg.variables.acceptUrl);
      expect(url.pathname).toBe(`/${locale}/invite`);
      expect(url.searchParams.get("token")).toBe("tok");
    },
  );

  it("falls back to the inviter email when there is no display name", async () => {
    inviterRow = { display_name: null, primary_email: "ada@x.com" };
    await sendInvitationEmail({
      to: "invitee@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      inviterAppUserId: "admin-1",
      plaintextToken: "tok",
      locale: "en",
    });
    const arg = sendAppEmailMock.mock.calls[0]![0] as { variables: { inviterName: string } };
    expect(arg.variables.inviterName).toBe("ada@x.com");
  });

  it("skips the DB lookup and uses a generic label when there is no inviter id", async () => {
    await sendInvitationEmail({
      to: "invitee@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      inviterAppUserId: null,
      plaintextToken: "tok",
      locale: "en",
    });
    expect(inviterSelect).not.toHaveBeenCalled();
    const arg = sendAppEmailMock.mock.calls[0]![0] as { variables: { inviterName: string } };
    expect(arg.variables.inviterName).toBe("An administrator");
  });
});
