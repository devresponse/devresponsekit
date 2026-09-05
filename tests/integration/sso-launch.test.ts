import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LaunchRouteModule from "@/app/api/sso/launch/route";
import type { NextRequest } from "next/server";

/**
 * Route integration tests for `/api/sso/launch` (§29.6.10).
 *
 * Mocks the auth-guard, the SSO redirect builder, and the audit module
 * so we can verify the route's contract: a missing / malformed
 * applicationId is rejected before any DB or audit work, unauthenticated
 * users are redirected to sign-in, impersonated sessions are refused
 * (review #4), launches are rate-limited per principal (review #16), and
 * successful launches set `Referrer-Policy: no-referrer` and
 * `Cache-Control: no-store`.
 */

const sessionGetter = vi.fn();
const createRedirect = vi.fn();
const auditMock = vi.fn();
const logErrMock = vi.fn();
const captureMock = vi.fn();
const signerConfigured = vi.hoisted(() => ({ value: true }));

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
  // Mirror the real helper: `session.session.impersonatedBy` (camel) or the
  // raw `impersonated_by` column, else null.
  getImpersonatorId: (
    session: {
      session?: { impersonatedBy?: string | null; impersonated_by?: string | null };
    } | null,
  ) => session?.session?.impersonatedBy ?? session?.session?.impersonated_by ?? null,
}));
vi.mock("@/lib/sso.server", () => ({
  createSsoHandoffRedirect: (input: unknown) => createRedirect(input),
}));
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
vi.mock("@/lib/jwt-handoff.server", () => ({
  isSsoHandoffSignerConfigured: () => signerConfigured.value,
}));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logErrMock(...args),
}));
vi.mock("@/lib/observability/server", () => ({
  captureServerError: (...args: unknown[]) => captureMock(...args),
}));

function makeRequest(url: string, headers: Record<string, string> = {}): NextRequest {
  const u = new URL(url);
  // The route only reads `nextUrl.searchParams`, `request.url` and headers.
  return {
    nextUrl: u,
    url: u.toString(),
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

let GET: typeof LaunchRouteModule.GET;

beforeEach(async () => {
  sessionGetter.mockReset();
  createRedirect.mockReset();
  auditMock.mockReset();
  logErrMock.mockReset();
  captureMock.mockReset();
  signerConfigured.value = true;
  // A fresh module graph per test also resets the in-memory limiter buckets.
  ({ GET } = await import("@/app/api/sso/launch/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/sso/launch", () => {
  it("rejects requests without applicationId before any session or audit work (#16)", async () => {
    const res = await GET(makeRequest("http://localhost/api/sso/launch?locale=en"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_application_id" });
    // No DB work of any kind: no session lookup, no audit row, no mint.
    expect(sessionGetter).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(createRedirect).not.toHaveBeenCalled();
  });

  it.each(["BAD ID", "../etc", "Portal", "-leading", "a".repeat(129), "x<script>"])(
    "rejects a malformed applicationId %j with 400 and no DB query (#16)",
    async (bad) => {
      const res = await GET(
        makeRequest(
          `http://localhost/api/sso/launch?applicationId=${encodeURIComponent(bad)}&locale=en`,
        ),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_application_id" });
      expect(sessionGetter).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
      expect(createRedirect).not.toHaveBeenCalled();
    },
  );

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

  it("still launches for a plain (non-impersonated) session whose `session` object is present", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-1" },
      session: { id: "s-1", impersonatedBy: null },
    });
    createRedirect.mockResolvedValue(
      new URL("https://portal.devresponse.com/api/sso/consume?token=abc"),
    );
    const res = await GET(
      makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=en"),
    );
    expect(res.status).toBe(307);
    expect(createRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: "portal", betterAuthUserId: "ba-1" }),
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

describe("GET /api/sso/launch — no signing key configured (review #5)", () => {
  it("fails closed with 503 sso_not_configured, audits + logs, and never touches the nonce table", async () => {
    signerConfigured.value = false;
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });

    const res = await GET(
      makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=en"),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "sso_not_configured" });
    expect(createRedirect).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.launch.failure",
        outcome: "error",
        reason: "signing_key_not_configured",
        actorBetterAuthUserId: "ba-1",
        targetApplicationId: "portal",
      }),
    );
    expect(logErrMock).toHaveBeenCalledWith(
      "sso.launch.config_error",
      expect.objectContaining({ reason: "signing_key_not_configured" }),
    );
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it("is checked AFTER authentication so an anonymous probe learns nothing about the config", async () => {
    signerConfigured.value = false;
    sessionGetter.mockResolvedValue(null);
    const res = await GET(makeRequest("http://localhost/api/sso/launch?applicationId=portal"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });
});

describe("GET /api/sso/launch — impersonated sessions are refused (review #4)", () => {
  it("returns 403 forbidden_while_impersonating, never mints, and attributes the audit row to the impersonator", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-target" },
      session: { id: "s-imp", impersonatedBy: "ba-admin" },
    });

    const res = await GET(
      makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=en"),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_while_impersonating" });
    // The exploit path: no handoff token is ever minted for the target.
    expect(createRedirect).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.launch.failure",
        outcome: "denied",
        reason: "forbidden_while_impersonating",
        actorBetterAuthUserId: "ba-admin",
        targetApplicationId: "portal",
        metadata: { impersonatedBetterAuthUserId: "ba-target" },
      }),
    );
  });

  it("also honours the snake_case `impersonated_by` column shape", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-target" },
      session: { id: "s-imp", impersonated_by: "ba-admin" },
    });
    const res = await GET(makeRequest("http://localhost/api/sso/launch?applicationId=portal"));
    expect(res.status).toBe(403);
    expect(createRedirect).not.toHaveBeenCalled();
  });
});

describe("GET /api/sso/launch — per-principal rate limit (review #16)", () => {
  const url = "http://localhost/api/sso/launch?applicationId=portal&locale=en";

  it("returns 429 with Retry-After once a signed-in user exhausts the burst, without minting", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-noisy" } });
    createRedirect.mockResolvedValue(
      new URL("https://portal.devresponse.com/api/sso/consume?token=abc"),
    );

    // DEFAULT_SSO_LAUNCH_LIMIT: 30-token burst.
    for (let i = 0; i < 30; i += 1) {
      const ok = await GET(makeRequest(url));
      expect(ok.status).toBe(307);
    }
    createRedirect.mockClear();
    auditMock.mockClear();

    const denied = await GET(makeRequest(url));
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await denied.json()).toMatchObject({ error: "rate_limited" });
    expect(createRedirect).not.toHaveBeenCalled();
    // The denial must not write an `sso.launch.*` audit row per request.
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: expect.stringMatching(/^sso\.launch/) }),
    );
  });

  it("keys on the principal — another user is unaffected by a noisy one", async () => {
    createRedirect.mockResolvedValue(
      new URL("https://portal.devresponse.com/api/sso/consume?token=abc"),
    );
    sessionGetter.mockResolvedValue({ user: { id: "ba-noisy" } });
    for (let i = 0; i < 30; i += 1) await GET(makeRequest(url));
    expect((await GET(makeRequest(url))).status).toBe(429);

    sessionGetter.mockResolvedValue({ user: { id: "ba-quiet" } });
    expect((await GET(makeRequest(url))).status).toBe(307);
  });

  it("throttles the signed-out path per trusted client IP, bounding the `unauthenticated` audit writes", async () => {
    sessionGetter.mockResolvedValue(null);
    const fromIp = (ip: string) => makeRequest(url, { "x-forwarded-for": ip });

    for (let i = 0; i < 30; i += 1) {
      expect((await GET(fromIp("203.0.113.9"))).status).toBe(307);
    }
    auditMock.mockClear();
    const denied = await GET(fromIp("203.0.113.9"));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.launch.failure" }),
    );

    // A different IP still gets its own budget.
    expect((await GET(fromIp("198.51.100.4"))).status).toBe(307);
  });
});
