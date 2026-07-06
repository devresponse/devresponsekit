import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
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

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", () => ({
  getUserAccessContext: (id: string) => accessGetter(id),
}));
vi.mock("@/lib/active-org.server", () => ({
  ACTIVE_ORG_COOKIE: "active_org",
  userHasActiveMembership: (...a: unknown[]) => hasMembership(...a),
}));
vi.mock("@/lib/org-lookup.server", () => ({
  resolveOrganizationByIdentifier: (...a: unknown[]) => resolveOrg(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function req(org: string | null, next: string | null): NextRequest {
  const url = new URL("http://localhost:3000/api/preferences/active-org/apply");
  if (org !== null) url.searchParams.set("org", org);
  if (next !== null) url.searchParams.set("next", next);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "GET",
  } as unknown as NextRequest;
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

  it("returns early (no session lookup) when no org is given", async () => {
    const res = await GET(req(null, "/en/app/workspace"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/en/app/workspace");
    expect(sessionGetter).not.toHaveBeenCalled();
    expect(res.cookies.get("active_org")).toBeUndefined();
  });

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
