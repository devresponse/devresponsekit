import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("falls back to the inviter email when there is no display name", async () => {
    inviterRow = { display_name: null, primary_email: "ada@x.com" };
    await sendInvitationEmail({
      to: "invitee@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      inviterAppUserId: "admin-1",
      plaintextToken: "tok",
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
    });
    expect(inviterSelect).not.toHaveBeenCalled();
    const arg = sendAppEmailMock.mock.calls[0]![0] as { variables: { inviterName: string } };
    expect(arg.variables.inviterName).toBe("An administrator");
  });
});
