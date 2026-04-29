import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LaunchRouteModule from "@/app/api/sso/launch/route";
import type { NextRequest } from "next/server";

/**
 * Route integration tests for `/api/sso/launch` (§29.6.10).
 *
 * Mocks the auth-guard, the SSO redirect builder, and the audit module
 * so we can verify the route's contract: missing applicationId is
 * audited and rejected, unauthenticated users are redirected to
 * sign-in, and successful launches set `Referrer-Policy: no-referrer`
 * and `Cache-Control: no-store`.
 */

const sessionGetter = vi.fn();
const createRedirect = vi.fn();
const auditMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/sso.server", () => ({
  createSsoHandoffRedirect: (input: unknown) => createRedirect(input),
}));
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

function makeRequest(url: string): NextRequest {
  const u = new URL(url);
  // The route only reads `nextUrl.searchParams` and `request.url`.
  return {
    nextUrl: u,
    url: u.toString(),
    headers: new Headers(),
  } as unknown as NextRequest;
}

let GET: typeof LaunchRouteModule.GET;

beforeEach(async () => {
  sessionGetter.mockReset();
  createRedirect.mockReset();
  auditMock.mockReset();
  ({ GET } = await import("@/app/api/sso/launch/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/sso/launch", () => {
  it("rejects requests without applicationId and audits a failure", async () => {
    const res = await GET(makeRequest("http://localhost/api/sso/launch?locale=en"));
    expect(res.status).toBe(400);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.launch.failure",
        outcome: "failure",
        reason: "missing_application_id",
      }),
    );
  });

  it("redirects unauthenticated users to localized sign-in", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(
      makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=fr"),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/fr/sign-in");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.launch.failure",
        reason: "unauthenticated",
        targetApplicationId: "portal",
      }),
    );
  });

  it("falls back to the default locale when `locale` is unsupported", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(
      makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=zz"),
    );
    expect(res.headers.get("location")).toContain("/en/sign-in");
  });

  it("issues the redirect with no-referrer + no-store on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    createRedirect.mockResolvedValue(
      new URL("https://portal.devresponse.com/api/sso/consume?token=abc"),
    );

    const res = await GET(
      makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=en"),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toContain("portal.devresponse.com");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.launch.success",
        outcome: "success",
      }),
    );
  });

  it("returns 403 and audits the reason when the redirect builder throws", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    createRedirect.mockRejectedValue(new Error("sso_denied:application_unavailable"));

    const res = await GET(
      makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=en"),
    );
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.launch.failure",
        reason: "sso_denied:application_unavailable",
      }),
    );
  });
});
