import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AcceptRoute from "@/app/api/invitations/accept/route";

/**
 * Integration tests for POST /api/invitations/accept (0008) — the explicit
 * acceptance path for signed-in users.
 *
 * Pins the contract: session required but NOT active membership (pending
 * users are the primary audience), one generic `invitation_invalid` for
 * every dead-token shape, `invitation_email_mismatch` against the SESSION
 * email, and consume-refusals mapping (blocked users → forbidden). The
 * invitations lib is stubbed (its own behavior is unit/DB-tested).
 */
const sessionGetter = vi.fn();
const findInvitationMock = vi.fn();
const consumeMock = vi.fn();
const selectFirst = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/invitations.server", () => ({
  findValidInvitationByToken: (...a: unknown[]) => findInvitationMock(...a),
  consumeInvitation: (...a: unknown[]) => consumeMock(...a),
}));
vi.mock("@/db/database", () => {
  function makeChain(): unknown {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return selectFirst;
        return () => makeChain();
      },
    };
    return new Proxy({}, handler);
  }
  return { db: { selectFrom: () => makeChain() } };
});

const INVITATION = {
  id: "inv-1",
  organizationId: "org-1",
  organizationName: "Org One",
  email: "ada@example.com",
  roleId: null,
  status: "pending",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
};

function req(body: unknown): NextRequest {
  return {
    nextUrl: new URL("http://test.local/api/invitations/accept"),
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

let POST: typeof AcceptRoute.POST;

beforeEach(async () => {
  for (const m of [sessionGetter, findInvitationMock, consumeMock, selectFirst]) m.mockReset();
  sessionGetter.mockResolvedValue({
    user: { id: "ba-1", email: "ada@example.com" },
  });
  findInvitationMock.mockResolvedValue(INVITATION);
  consumeMock.mockResolvedValue({ consumed: true, roleGranted: false });
  selectFirst.mockResolvedValue({ id: "user-1", status: "pending_approval" });
  ({ POST } = await import("@/app/api/invitations/accept/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/invitations/accept", () => {
  it("returns 401 without a session", async () => {
    sessionGetter.mockResolvedValue(null);
    expect((await POST(req({ token: "t" }))).status).toBe(401);
  });

  it("returns 400 for a malformed body", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ token: "" }))).status).toBe(400);
  });

  it("returns one generic 404 invitation_invalid for dead tokens", async () => {
    findInvitationMock.mockResolvedValue(null);
    const res = await POST(req({ token: "unknown-or-expired-or-revoked" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("invitation_invalid");
  });

  it("returns 403 invitation_email_mismatch when the SESSION email differs", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1", email: "other@example.com" } });
    const res = await POST(req({ token: "t" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("invitation_email_mismatch");
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it("accepts a PENDING (not yet approved) user — that is the point", async () => {
    const res = await POST(req({ token: "t" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ ok: true, organizationId: "org-1" });
    expect(consumeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appUser: expect.objectContaining({
          id: "user-1",
          primaryEmail: "ada@example.com",
          status: "pending_approval",
        }),
        actorBetterAuthUserId: "ba-1",
      }),
    );
  });

  it("maps a not-eligible consume (blocked user) to 403 forbidden", async () => {
    consumeMock.mockResolvedValue({ consumed: false, reason: "user_not_eligible" });
    const res = await POST(req({ token: "t" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("maps a lost consume race to the generic 404", async () => {
    consumeMock.mockResolvedValue({ consumed: false, reason: "already_consumed" });
    const res = await POST(req({ token: "t" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("invitation_invalid");
  });

  it("returns 403 when the session user has no app_users row", async () => {
    selectFirst.mockResolvedValue(undefined);
    const res = await POST(req({ token: "t" }));
    expect(res.status).toBe(403);
    expect(consumeMock).not.toHaveBeenCalled();
  });
});
