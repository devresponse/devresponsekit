import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RouteModule from "@/app/api/preferences/active-org/route";

/**
 * Contract for `POST /api/preferences/active-org` (multi-org switcher).
 * The cookie is only allowed to name an org the caller is an ACTIVE member
 * of — the membership check is the authority, the cookie is a selector.
 *
 * Since review #28 the route authenticates through the shared self-service
 * guard (`requireAccountUser`, exercised for REAL here — only the session
 * and access lookups underneath it are mocked), and refuses bearer callers
 * and impersonated sessions on top of it.
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
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/active-org.server", () => ({
  ACTIVE_ORG_COOKIE: "active_org",
  userHasActiveMembership: (...a: unknown[]) => hasMembership(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    json: async () => body,
    headers: new Headers(headers),
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
    // The shared guard answers with the first-party envelope (P3-12).
    const body = (await res.json()) as { error: string; message: string; requestId: string };
    expect(body).toMatchObject({ error: "untrusted_origin", message: "errors.untrusted_origin" });
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
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
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unauthenticated" });
  });

  it("returns 403 when the caller is not an active member (pending user cannot switch)", async () => {
    accessGetter.mockResolvedValue({
      ...activeAccess,
      status: "pending_approval",
      membershipStatus: "pending_approval",
    });
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "forbidden" });
    expect(hasMembership).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not provisioned", async () => {
    accessGetter.mockResolvedValue({ ...activeAccess, appUserId: null });
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_provisioned" });
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
    // The authority check ran for THIS caller's app user and the requested org.
    expect(hasMembership).toHaveBeenCalledWith("u-1", ORG_ID);
    expect(res.cookies.get("active_org")?.value).toBe(ORG_ID);
    expect(res.cookies.get("active_org")?.httpOnly).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "account.active_organization.changed",
        actorBetterAuthUserId: "ba-1",
        appUserId: "u-1",
        organizationId: ORG_ID,
      }),
    );
  });

  it("returns 403 and does NOT switch tenant while impersonating (P0-1)", async () => {
    // The impersonated session carries `impersonatedBy`; even though the
    // impersonated user is an active member of the target org, the switch must
    // be refused so an impersonation cannot pivot into another tenant. The
    // marker now reaches the route through the REAL guard + caller resolver
    // (review #28) — nothing between the session and the refusal is mocked.
    sessionGetter.mockResolvedValue({
      user: { id: "ba-1" },
      session: { impersonatedBy: "admin-9" },
    });
    hasMembership.mockResolvedValue(true);
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_while_impersonating" });
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(hasMembership).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("still refuses the snake_case impersonation marker (plugin version drift, P0-1)", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-1" },
      session: { impersonated_by: "admin-9" },
    });
    hasMembership.mockResolvedValue(true);
    const res = await POST(req({ organizationId: ORG_ID }));
    expect(res.status).toBe(403);
    expect(res.cookies.get("active_org")).toBeUndefined();
  });

  it("never falls back to the ambient session for a bearer request (401 when the credential does not resolve)", async () => {
    // Machine credentials are off in the test env, so the resolver yields no
    // caller for the bearer header; the guard must 401 rather than quietly
    // authenticate the cookie session behind it. The refusal of a RESOLVED
    // bearer caller is pinned in active-org-route-bearer.test.ts.
    hasMembership.mockResolvedValue(true);
    const res = await POST(
      req({ organizationId: ORG_ID }, { authorization: "Bearer drk_test_x.secret" }),
    );
    expect(res.status).toBe(401);
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(hasMembership).not.toHaveBeenCalled();
    expect(sessionGetter).not.toHaveBeenCalled();
  });

  it("throttles a scripted switch loop per user with 429 + Retry-After (review #28)", async () => {
    hasMembership.mockResolvedValue(true);
    // DEFAULT_ADMIN_MUTATION_LIMIT: 30-token burst.
    for (let i = 0; i < 30; i += 1) {
      expect((await POST(req({ organizationId: ORG_ID }))).status).toBe(200);
    }
    hasMembership.mockClear();
    const denied = await POST(req({ organizationId: ORG_ID }));
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(denied.cookies.get("active_org")).toBeUndefined();
    expect(hasMembership).not.toHaveBeenCalled();
  });
});
