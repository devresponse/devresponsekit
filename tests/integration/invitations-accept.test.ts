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
 *
 * F-33: a successful accept pins `active_org` to the inviting org, under the
 * same rules as the switcher — only for an ACTIVE membership, never for an
 * impersonated session, audited, and with the switcher's cookie attributes.
 * The live-row version is tests/db/active-org-resolution.db.test.ts.
 */
const sessionGetter = vi.fn();
const findInvitationMock = vi.fn();
const consumeMock = vi.fn();
const selectFirst = vi.fn();
const userHasActiveMembership = vi.fn();
const auditEvent = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
// The per-user floor consumes from the SHARED Postgres bucket (review #98);
// no database here, so it is routed through the in-memory helper, which
// answers the same 429 envelope.
vi.mock("@/lib/admin/rate-limit-shared.server", async () => {
  const { enforceRateLimit } = await import("@/lib/admin/rate-limit.server");
  return {
    enforceSharedRateLimit: async (...a: Parameters<typeof enforceRateLimit>) =>
      enforceRateLimit(...a),
  };
});
vi.mock("@/lib/invitations.server", () => ({
  findValidInvitationByToken: (...a: unknown[]) => findInvitationMock(...a),
  consumeInvitation: (...a: unknown[]) => consumeMock(...a),
}));
vi.mock("@/lib/active-org.server", () => ({
  userHasActiveMembership: (...a: unknown[]) => userHasActiveMembership(...a),
}));
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...a: unknown[]) => auditEvent(...a),
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
  for (const m of [
    sessionGetter,
    findInvitationMock,
    consumeMock,
    selectFirst,
    userHasActiveMembership,
    auditEvent,
  ]) {
    m.mockReset();
  }
  sessionGetter.mockResolvedValue({
    user: { id: "ba-1", email: "ada@example.com" },
  });
  findInvitationMock.mockResolvedValue(INVITATION);
  consumeMock.mockResolvedValue({ consumed: true, roleGranted: false });
  selectFirst.mockResolvedValue({ id: "user-1", status: "pending_approval" });
  userHasActiveMembership.mockResolvedValue(true);
  auditEvent.mockResolvedValue(undefined);
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

describe("POST /api/invitations/accept — F-33 pins the active org to the org just joined", () => {
  it("sets active_org to the inviting org, with the switcher's attributes, and audits the change", async () => {
    const res = await POST(req({ token: "t" }));

    expect(res.status).toBe(200);
    // The gate is the one the switcher uses, asked about THIS user and org.
    expect(userHasActiveMembership).toHaveBeenCalledWith("user-1", "org-1");
    const cookie = res.cookies.get("active_org");
    expect(cookie?.value).toBe("org-1");
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    // Host-only, like the other two writers: the org selector never follows
    // COOKIE_DOMAIN to the satellites.
    expect(cookie?.domain).toBeUndefined();
    expect(auditEvent).toHaveBeenCalledTimes(1);
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "account.active_organization.changed",
        outcome: "success",
        actorBetterAuthUserId: "ba-1",
        appUserId: "user-1",
        organizationId: "org-1",
        metadata: { organizationId: "org-1", source: "invitation_accepted" },
      }),
    );
  });

  it("does not pin when the membership did not end up ACTIVE (an admin's block or suspension stands)", async () => {
    // consumeInvitation leaves a blocked/suspended membership as it was; the
    // cookie must never name an org the caller cannot enter.
    userHasActiveMembership.mockResolvedValue(false);
    const res = await POST(req({ token: "t" }));

    expect(res.status).toBe(200);
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("never pins for an impersonated session (P0-1: switching tenant is the user's own act)", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-1", email: "ada@example.com" },
      session: { impersonatedBy: "ba-admin" },
    });
    const res = await POST(req({ token: "t" }));

    expect(res.status).toBe(200);
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(userHasActiveMembership).not.toHaveBeenCalled();
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("never pins when the accept itself is refused", async () => {
    for (const reason of ["user_not_eligible", "email_mismatch", "already_consumed"]) {
      consumeMock.mockResolvedValue({ consumed: false, reason });
      const res = await POST(req({ token: "t" }));
      expect(res.status, reason).not.toBe(200);
      expect(res.cookies.get("active_org"), reason).toBeUndefined();
    }
    expect(userHasActiveMembership).not.toHaveBeenCalled();
    expect(auditEvent).not.toHaveBeenCalled();
  });
});
