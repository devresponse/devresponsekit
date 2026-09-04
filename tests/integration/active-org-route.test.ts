import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as RouteModule from "@/app/api/preferences/active-org/route";

/**
 * Contract for `POST /api/preferences/active-org` (multi-org switcher).
 * The cookie is only allowed to name an org the caller is an ACTIVE member
 * of — the membership check is the authority, the cookie is a selector.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const hasMembership = vi.fn();
const auditMock = vi.fn();
const originCheck = vi.fn();

// The CSRF origin guard short-circuits under NODE_ENV=test, so it is mocked
// here to drive the deny path (its matching logic has its own unit suite).
vi.mock("@/lib/admin/origin-guard.server", () => ({
  checkTrustedOrigin: (...a: unknown[]) => originCheck(...a),
}));
vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
  getImpersonatorId: (s: unknown) =>
    (s as { session?: { impersonatedBy?: string | null } } | null)?.session?.impersonatedBy ?? null,
}));
vi.mock("@/lib/auth-status", () => ({
  getUserAccessContext: (id: string) => accessGetter(id),
  decideSecureAccess: (status: string) =>
    status === "blocked" ? "blocked" : status === "active" ? "allow" : "pending_approval",
}));
vi.mock("@/lib/active-org.server", () => ({
  ACTIVE_ORG_COOKIE: "active_org",
  userHasActiveMembership: (...a: unknown[]) => hasMembership(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
    method: "POST",
  } as unknown as NextRequest;
}

const activeAccess = {
  appUserId: "u-1",
  primaryEmail: "u@x.com",
  status: "active",
  organizationId: "o-current",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view"],
};

let POST: typeof RouteModule.POST;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, hasMembership, auditMock, originCheck]) {
    m.mockReset();
  }
  originCheck.mockReturnValue({ ok: true });
  sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
  accessGetter.mockResolvedValue(activeAccess);
  ({ POST } = await import("@/app/api/preferences/active-org/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/preferences/active-org", () => {
  it("returns 403 untrusted_origin on a cross-origin request BEFORE touching the session (review #39/#188)", async () => {
    originCheck.mockReturnValue({ ok: false, reason: "untrusted_origin" });
    hasMembership.mockResolvedValue(true);
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "untrusted_origin" });
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(sessionGetter).not.toHaveBeenCalled();
    expect(hasMembership).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 403 when neither Origin nor Referer is present (missing_origin)", async () => {
    originCheck.mockReturnValue({ ok: false, reason: "missing_origin" });
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(403);
    expect(sessionGetter).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not provisioned", async () => {
    accessGetter.mockResolvedValue({ ...activeAccess, appUserId: null });
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid body", async () => {
    const res = await POST(req({ organizationId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(hasMembership).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller is not an active member of the target org", async () => {
    hasMembership.mockResolvedValue(false);
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(404);
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("sets the active_org cookie and audits when the caller is an active member", async () => {
    hasMembership.mockResolvedValue(true);
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(200);
    expect(res.cookies.get("active_org")?.value).toBe(ORG_ID);
    expect(res.cookies.get("active_org")?.httpOnly).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.active_organization.changed" }),
    );
  });

  it("returns 403 and does NOT switch tenant while impersonating (P0-1)", async () => {
    // The impersonated session carries `impersonatedBy`; even though the
    // impersonated user is an active member of the target org, the switch must
    // be refused so an impersonation cannot pivot into another tenant.
    sessionGetter.mockResolvedValue({
      user: { id: "ba-1" },
      session: { impersonatedBy: "admin-9" },
    });
    hasMembership.mockResolvedValue(true);
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(403);
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(hasMembership).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
