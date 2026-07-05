import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as InvitationsRoute from "@/app/api/administrator/organizations/[id]/invitations/route";
import type * as InvitationByIdRoute from "@/app/api/administrator/organizations/[id]/invitations/[invitationId]/route";
import type * as ResendRoute from "@/app/api/administrator/organizations/[id]/invitations/[invitationId]/resend/route";

/**
 * Integration tests for the invitation admin endpoints (0008):
 *
 *   /api/administrator/organizations/:id/invitations                     (GET/POST)
 *   /api/administrator/organizations/:id/invitations/:invitationId       (DELETE)
 *   /api/administrator/organizations/:id/invitations/:invitationId/resend (POST)
 *
 * The DB layer and the invitations lib are stubbed — these pin the handler
 * contract: permission gates, machine codes (member_exists /
 * invitation_exists / role_not_found / invitation_not_found), outbox email
 * dispatch, and audit emission. ADR-0001 foreign-org scoping is covered in
 * org-scoped-admin-routes; the lib itself in tests/unit/invitations.test.ts.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const selectFirst = vi.fn();
const executeMock = vi.fn();
const sendEmailMock = vi.fn();
const createInvitationMock = vi.fn();
const revokeInvitationMock = vi.fn();
const regenerateMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
vi.mock("@/lib/email/send.server", () => ({
  sendAppEmail: (...args: unknown[]) => sendEmailMock(...args),
}));
vi.mock("@/lib/invitations.server", () => ({
  createInvitation: (...args: unknown[]) => createInvitationMock(...args),
  revokeInvitation: (...args: unknown[]) => revokeInvitationMock(...args),
  regenerateInvitationToken: (...args: unknown[]) => regenerateMock(...args),
  buildInvitationAcceptUrl: (token: string) => `http://test.local/en/invite?token=${token}`,
}));

vi.mock("@/db/database", () => {
  function makeChain(): unknown {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return selectFirst;
        if (prop === "executeTakeFirstOrThrow") return selectFirst;
        if (prop === "execute") return executeMock;
        return (...args: unknown[]) => {
          const cb = args[0];
          if (typeof cb === "function") {
            try {
              (cb as (eb: unknown) => unknown)(
                new Proxy(() => ({}), { get: () => () => ({}), apply: () => ({}) }),
              );
            } catch {
              /* ignore */
            }
          }
          return makeChain();
        };
      },
    };
    return new Proxy({}, handler);
  }
  return {
    db: {
      selectFrom: () => makeChain(),
      insertInto: () => makeChain(),
      updateTable: () => makeChain(),
      deleteFrom: () => makeChain(),
    },
  };
});

const ORG_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const INVITATION_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const ROLE_ID = "c3d4e5f6-a7b8-4012-8def-123456789012";
const BASE = `http://test.local/api/administrator/organizations/${ORG_ID}/invitations`;

const ORG_ROW = { id: ORG_ID, slug: "test-org", name: "Test Org" };
const INVITER_ROW = { display_name: "Admin Ada", primary_email: "ada@x.com" };

function getReq(url: string): NextRequest {
  return { nextUrl: new URL(url), headers: new Headers() } as unknown as NextRequest;
}
function jsonReq(url: string, body: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const OK_ACCESS = (perms: string[]) => ({
  appUserId: "admin-app-user",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [...perms, "superuser"],
});
const ORG_ADMIN = (perms: string[]) => ({
  ...OK_ACCESS(perms),
  organizationId: ORG_ID,
  permissions: perms,
});

let listGET: typeof InvitationsRoute.GET;
let createPOST: typeof InvitationsRoute.POST;
let revokeDELETE: typeof InvitationByIdRoute.DELETE;
let resendPOST: typeof ResendRoute.POST;

const listCtx = () => ({ params: Promise.resolve({ id: ORG_ID }) });
const itemCtx = () => ({
  params: Promise.resolve({ id: ORG_ID, invitationId: INVITATION_ID }),
});

beforeEach(async () => {
  for (const m of [
    sessionGetter,
    accessGetter,
    auditMock,
    selectFirst,
    executeMock,
    sendEmailMock,
    createInvitationMock,
    revokeInvitationMock,
    regenerateMock,
  ])
    m.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: "ba-admin" } });
  selectFirst.mockResolvedValue(ORG_ROW);
  executeMock.mockResolvedValue([]);
  sendEmailMock.mockResolvedValue({ outboxId: "out-1", status: "logged" });
  createInvitationMock.mockResolvedValue({
    id: INVITATION_ID,
    plaintextToken: "tok-plain",
    expiresAt: new Date("2026-08-01T00:00:00Z"),
  });
  revokeInvitationMock.mockResolvedValue(true);
  regenerateMock.mockResolvedValue({
    plaintextToken: "tok-rotated",
    expiresAt: new Date("2026-08-01T00:00:00Z"),
  });
  ({ GET: listGET, POST: createPOST } =
    await import("@/app/api/administrator/organizations/[id]/invitations/route"));
  ({ DELETE: revokeDELETE } =
    await import("@/app/api/administrator/organizations/[id]/invitations/[invitationId]/route"));
  ({ POST: resendPOST } =
    await import("@/app/api/administrator/organizations/[id]/invitations/[invitationId]/resend/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/organizations/:id/invitations", () => {
  it("returns 403 when caller lacks admin.orgs.read", async () => {
    accessGetter.mockResolvedValue(ORG_ADMIN(["shell.view"]));
    expect((await listGET(getReq(BASE), listCtx())).status).toBe(403);
  });

  it("returns the standard list envelope", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    executeMock.mockResolvedValue([
      {
        id: INVITATION_ID,
        email: "ada@example.com",
        status: "pending",
        role_id: null,
        role_name: null,
        invited_by_display_name: "Admin Ada",
        expires_at: "2026-08-01T00:00:00Z",
        accepted_at: null,
        created_at: "2026-07-05T00:00:00Z",
        updated_at: "2026-07-05T00:00:00Z",
        total: "1",
      },
    ]);
    const res = await listGET(getReq(BASE), listCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });
});

describe("POST /api/administrator/organizations/:id/invitations", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await createPOST(jsonReq(BASE, { email: "a@b.co" }), listCtx());
    expect(res.status).toBe(403);
  });

  it("rejects an invalid email with 400", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await createPOST(jsonReq(BASE, { email: "not-an-email" }), listCtx());
    expect(res.status).toBe(400);
  });

  it("returns 404 role_not_found for a role outside this org", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst.mockResolvedValueOnce(ORG_ROW).mockResolvedValueOnce(undefined); // role lookup misses
    const res = await createPOST(
      jsonReq(BASE, { email: "ada@example.com", roleId: ROLE_ID }),
      listCtx(),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("role_not_found");
  });

  it("returns 409 member_exists when the address already belongs to an active member", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst.mockResolvedValueOnce(ORG_ROW).mockResolvedValueOnce({ id: "m-1" }); // active-member lookup hits
    const res = await createPOST(jsonReq(BASE, { email: "ada@example.com" }), listCtx());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("member_exists");
  });

  it("returns 409 invitation_exists on the pending-unique violation", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst.mockResolvedValueOnce(ORG_ROW).mockResolvedValueOnce(undefined);
    createInvitationMock.mockRejectedValue(new Error("duplicate key value violates unique"));
    const res = await createPOST(jsonReq(BASE, { email: "ada@example.com" }), listCtx());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("invitation_exists");
  });

  it("creates, emails the accept link through the outbox, and audits", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst
      .mockResolvedValueOnce(ORG_ROW)
      .mockResolvedValueOnce(undefined) // no active member
      .mockResolvedValueOnce(INVITER_ROW);
    const res = await createPOST(jsonReq(BASE, { email: "Ada@Example.com " }), listCtx());
    expect(res.status).toBe(201);
    expect(createInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, email: "ada@example.com" }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        templateKey: "organization_invitation",
        variables: expect.objectContaining({
          inviterName: "Admin Ada",
          organizationName: "Test Org",
          acceptUrl: "http://test.local/en/invite?token=tok-plain",
        }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.organization.invitation_created",
        organizationId: ORG_ID,
      }),
    );
  });
});

describe("DELETE /api/administrator/organizations/:id/invitations/:invitationId", () => {
  it("returns 404 invitation_not_found when nothing pending was revoked", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    revokeInvitationMock.mockResolvedValue(false);
    const res = await revokeDELETE(getReq(`${BASE}/${INVITATION_ID}`), itemCtx());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("invitation_not_found");
  });

  it("revokes and audits", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await revokeDELETE(getReq(`${BASE}/${INVITATION_ID}`), itemCtx());
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.organization.invitation_revoked" }),
    );
  });
});

describe("POST .../invitations/:invitationId/resend", () => {
  it("returns 404 for an unknown invitation", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst.mockResolvedValueOnce(ORG_ROW).mockResolvedValueOnce(undefined);
    const res = await resendPOST(getReq(`${BASE}/${INVITATION_ID}/resend`), itemCtx());
    expect(res.status).toBe(404);
  });

  it("rotates the token, re-sends, and audits", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst
      .mockResolvedValueOnce(ORG_ROW)
      .mockResolvedValueOnce({ id: INVITATION_ID, email: "ada@example.com" })
      .mockResolvedValueOnce(INVITER_ROW);
    const res = await resendPOST(getReq(`${BASE}/${INVITATION_ID}/resend`), itemCtx());
    expect(res.status).toBe(200);
    expect(regenerateMock).toHaveBeenCalledWith({
      invitationId: INVITATION_ID,
      organizationId: ORG_ID,
    });
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({
          acceptUrl: "http://test.local/en/invite?token=tok-rotated",
        }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.organization.invitation_resent" }),
    );
  });
});
