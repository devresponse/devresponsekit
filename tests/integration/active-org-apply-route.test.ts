import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RouteModule from "@/app/api/preferences/active-org/apply/route";

/**
 * Contract for `GET /api/preferences/active-org/apply` — the post-sign-in
 * active-org applicator for the organization-scoped entry points.
 *
 * Every branch degrades to a plain redirect to the sanitized `next`; the
 * cookie is set ONLY for an active member of the resolved org, and `next` can
 * never become an off-origin redirect.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const hasMembership = vi.fn();
const resolveOrg = vi.fn();
const auditMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
  getImpersonatorId: (s: unknown) =>
    (s as { session?: { impersonatedBy?: string | null } } | null)?.session?.impersonatedBy ?? null,
}));
// The real rest of the module: POST /api/preferences/active-org's guard, driven
// below to drain the shared bucket, also reads `decideSecureAccess`.
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/active-org.server", () => ({
  ACTIVE_ORG_COOKIE: "active_org",
  userHasActiveMembership: (...a: unknown[]) => hasMembership(...a),
}));
vi.mock("@/lib/org-lookup.server", () => ({
  resolveOrganizationByIdentifier: (...a: unknown[]) => resolveOrg(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function req(
  org: string | null,
  next: string | null,
  staleHint = false,
  activeOrgCookie: string | null = null,
): NextRequest {
  const url = new URL("http://localhost:3000/api/preferences/active-org/apply");
  if (org !== null) url.searchParams.set("org", org);
  if (next !== null) url.searchParams.set("next", next);
  const cookies: Record<string, string | null> = {
    org_signup_hint: staleHint ? "acme" : null,
    active_org: activeOrgCookie,
  };
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "GET",
    cookies: {
      has: (name: string) => cookies[name] != null,
      get: (name: string) => (cookies[name] != null ? { name, value: cookies[name] } : undefined),
    },
  } as unknown as NextRequest;
}

/** The success rows this route writes (the limiter's own denial sample is another type). */
function switchAudits(): unknown[] {
  return auditMock.mock.calls.filter(
    ([input]) =>
      (input as { eventType?: string }).eventType === "account.active_organization.changed",
  );
}

let GET: typeof RouteModule.GET;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, hasMembership, resolveOrg, auditMock])
    m.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
  accessGetter.mockResolvedValue({
    appUserId: "u-1",
    status: "active",
    membershipStatus: "active",
  });
  resolveOrg.mockResolvedValue({ id: ORG_ID, slug: "acme", name: "Acme" });
  hasMembership.mockResolvedValue(true);
  ({ GET } = await import("@/app/api/preferences/active-org/apply/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/preferences/active-org/apply", () => {
  it("pins the active org and audits for an active member, then redirects to next", async () => {
    const res = await GET(req("acme", "/en/app/workspace"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/en/app/workspace");
    expect(res.cookies.get("active_org")?.value).toBe(ORG_ID);
    expect(res.cookies.get("active_org")?.httpOnly).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.active_organization.changed" }),
    );
  });

  it("redirects without a cookie when the caller is not a member of the org", async () => {
    hasMembership.mockResolvedValue(false);
    const res = await GET(req("acme", "/en/app/workspace"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/en/app/workspace");
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("redirects without a cookie for an unknown organization", async () => {
    resolveOrg.mockResolvedValue(null);
    const res = await GET(req("ghost", "/en/app/workspace"));
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(hasMembership).not.toHaveBeenCalled();
  });

  it("redirects without a cookie when unauthenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(req("acme", "/en/app/workspace"));
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(resolveOrg).not.toHaveBeenCalled();
  });

  it("redirects without a cookie when the caller is not provisioned", async () => {
    accessGetter.mockResolvedValue({ appUserId: null, status: "active", membershipStatus: null });
    const res = await GET(req("acme", "/en/app/workspace"));
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(resolveOrg).not.toHaveBeenCalled();
  });

  it("redirects without a cookie (no tenant change) while impersonating (P0-1)", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-1" },
      session: { impersonatedBy: "admin-9" },
    });
    const res = await GET(req("acme", "/en/app/workspace"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/en/app/workspace");
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(accessGetter).not.toHaveBeenCalled();
    expect(resolveOrg).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns early (no session lookup) when no org is given", async () => {
    const res = await GET(req(null, "/en/app/workspace"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/en/app/workspace");
    expect(sessionGetter).not.toHaveBeenCalled();
    expect(res.cookies.get("active_org")).toBeUndefined();
  });

  it("retires a stale org_signup_hint cookie when one is present", async () => {
    const res = await GET(req("acme", "/en/app/workspace", true));
    // A deletion surfaces as an empty-value Set-Cookie.
    expect(res.cookies.get("org_signup_hint")?.value).toBe("");
  });

  it("writes no audit row and no cookie when the org is already the active one (F-105)", async () => {
    const res = await GET(req("acme", "/en/app/workspace", false, ORG_ID));
    expect(res.headers.get("location")).toBe("http://localhost:3000/en/app/workspace");
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(switchAudits()).toHaveLength(0);
  });

  it("still switches when the browser's cookie names a different org", async () => {
    const res = await GET(req("acme", "/en/app/workspace", false, "another-org-id"));
    expect(res.cookies.get("active_org")?.value).toBe(ORG_ID);
    expect(switchAudits()).toHaveLength(1);
  });

  it("stops auditing a scripted loop once the per-user bucket is empty (F-105)", async () => {
    // DEFAULT_ADMIN_MUTATION_LIMIT: a 30-token burst, and the test is far
    // faster than the 1/s refill.
    for (let i = 0; i < 30; i++) {
      const res = await GET(req("acme", "/en/app/workspace"));
      expect(res.cookies.get("active_org")?.value).toBe(ORG_ID);
    }
    expect(switchAudits()).toHaveLength(30);

    const limited = await GET(req("acme", "/en/app/workspace"));
    // A browser landing: the refusal is the same plain redirect, never a 429.
    expect(limited.status).toBe(307);
    expect(limited.headers.get("location")).toBe("http://localhost:3000/en/app/workspace");
    expect(limited.cookies.get("active_org")).toBeUndefined();
    expect(switchAudits()).toHaveLength(30);
    // Charged before the lookups, so a refused hit costs no org query either.
    expect(resolveOrg).toHaveBeenCalledTimes(30);
  });

  it("draws on the same bucket as POST /api/preferences/active-org (F-105)", async () => {
    // Drain this user's bucket through the real switcher, so a scope or key
    // that drifts in either route fails here.
    const { POST } = await import("@/app/api/preferences/active-org/route");
    const post = () =>
      POST({
        json: async () => ({ organizationId: ORG_ID }),
        headers: new Headers(),
        method: "POST",
      } as unknown as NextRequest);
    let status = 200;
    for (let i = 0; i < 100 && status !== 429; i++) status = (await post()).status;
    expect(status).toBe(429);
    auditMock.mockClear();

    const res = await GET(req("acme", "/en/app/workspace"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/en/app/workspace");
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect(switchAudits()).toHaveLength(0);

    // Another user's bucket is untouched.
    sessionGetter.mockResolvedValue({ user: { id: "ba-2" } });
    const other = await GET(req("acme", "/en/app/workspace"));
    expect(other.cookies.get("active_org")?.value).toBe(ORG_ID);
  });

  it.each(["/en/sign-in\u0000", "/en/sign-in ", "/en/sign-in?x", "/en/../api/x"])(
    "never redirects to where the URL parser would take a refused `next` (I-17): %j",
    async (next) => {
      const res = await GET(req("acme", next));
      expect(res.headers.get("location")).toBe("http://localhost:3000/en/app/dashboard");
    },
  );

  it("sanitizes an off-origin `next` to the safe default, even for a member", async () => {
    const res = await GET(req("acme", "https://evil.com/steal"));
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("http://localhost:3000/")).toBe(true);
    expect(location).not.toContain("evil.com");
    expect(location).toBe("http://localhost:3000/en/app/dashboard");
    // The membership is still valid, so the cookie is still pinned.
    expect(res.cookies.get("active_org")?.value).toBe(ORG_ID);
  });
});
