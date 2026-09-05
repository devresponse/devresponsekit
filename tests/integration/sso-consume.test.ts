import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConsumeRouteModule from "@/app/api/sso/consume/route";
import type { NextRequest } from "next/server";
import type { BetterAuthOptions } from "better-auth";
import { getIp } from "better-auth/api";
import { CLIENT_IP_HEADER, getClientIp } from "@/lib/client-ip";

/**
 * Route integration tests for `/api/sso/consume` (§29.6.10 + §29.7.5, P2-2).
 *
 * The consume flow is split to defeat IdP-initiated login-CSRF:
 *   - GET verifies the token and redirects to the localized confirmation
 *     interstitial — it does NOT burn the nonce or establish a session.
 *   - POST (submitted by the interstitial, trusted-origin-guarded) burns the
 *     one-time jti, establishes the session, and 303s to the dashboard.
 */

const verifyMock = vi.fn();
const consumeMock = vi.fn();
const auditMock = vi.fn();
const createSsoSessionMock = vi.fn();
const logErrMock = vi.fn();
const captureMock = vi.fn();

vi.mock("@/lib/jwt-handoff.server", () => ({
  verifySsoHandoff: (...args: unknown[]) => verifyMock(...args),
}));
vi.mock("@/lib/sso.server", () => ({
  consumeSsoHandoffNonce: (...args: unknown[]) => consumeMock(...args),
}));
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      createSsoSession: (...args: unknown[]) => createSsoSessionMock(...args),
    },
  },
}));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logErrMock(...args),
}));
vi.mock("@/lib/observability/server", () => ({
  captureServerError: (...args: unknown[]) => captureMock(...args),
}));

function getRequest(url: string, headers: Record<string, string> = {}): NextRequest {
  const u = new URL(url);
  return {
    nextUrl: u,
    url: u.toString(),
    method: "GET",
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

function postRequest(token: string | null, headers: Record<string, string> = {}): NextRequest {
  const u = new URL("http://localhost/api/sso/consume");
  const form = new FormData();
  if (token !== null) form.set("token", token);
  return {
    nextUrl: u,
    url: u.toString(),
    method: "POST",
    headers: new Headers(headers),
    formData: async () => form,
  } as unknown as NextRequest;
}

const PAYLOAD = {
  jti: "j1",
  sub: "ba-1",
  targetApplicationId: "portal",
  email: "u@x.com",
  organizationId: "o-1",
  appUserId: "u-1",
  locale: "fr",
  roles: ["member"],
  iat: 0,
  exp: 60,
};

let GET: typeof ConsumeRouteModule.GET;
let POST: typeof ConsumeRouteModule.POST;

beforeEach(async () => {
  for (const m of [
    verifyMock,
    consumeMock,
    auditMock,
    createSsoSessionMock,
    logErrMock,
    captureMock,
  ])
    m.mockReset();
  createSsoSessionMock.mockResolvedValue({
    headers: new Headers([["set-cookie", "better-auth.session_token=tok.sig; Path=/; HttpOnly"]]),
    response: { ok: true },
  });
  process.env.SSO_HANDOFF_AUDIENCE_PREFIX = "devresponse-app";
  process.env.SSO_HANDOFF_APPLICATION_ID = "portal";
  ({ GET, POST } = await import("@/app/api/sso/consume/route"));
});
afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  delete process.env.SSO_HANDOFF_APPLICATION_ID;
});

describe("GET /api/sso/consume — verify + confirmation redirect (P2-2)", () => {
  it("rejects requests without a token and audits the failure", async () => {
    const res = await GET(getRequest("http://localhost/api/sso/consume"));
    expect(res.status).toBe(400);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure", reason: "missing_token" }),
    );
  });

  it("returns 500 if the application id is not configured, with a correlated request id + log", async () => {
    delete process.env.SSO_HANDOFF_APPLICATION_ID;
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    expect(logErrMock).toHaveBeenCalledWith(
      "sso.consume.config_error",
      expect.objectContaining({ reason: "application_id_not_configured" }),
    );
  });

  it("redirects a VALID token to the localized confirmation page WITHOUT burning the nonce or signing in", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/fr/sso/confirm");
    expect(res.headers.get("location")).toContain("token=abc");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // Critical: GET must NOT consume the nonce or establish a session.
    expect(consumeMock).not.toHaveBeenCalled();
    expect(createSsoSessionMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("returns 401 + audits when the token fails verification", async () => {
    verifyMock.mockRejectedValue(new Error("audience_mismatch"));
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(401);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure", reason: "audience_mismatch" }),
    );
  });
});

describe("POST /api/sso/consume — confirmed sign-in (P2-2)", () => {
  it("burns the nonce, establishes the session, and 303s to the dashboard with the cookie", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(true);
    const res = await POST(postRequest("abc"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/fr/app/dashboard");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The burn is bound to THIS deployment's application id (review #15).
    expect(consumeMock).toHaveBeenCalledWith("j1", "portal");
    expect(createSsoSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "ba-1" }, returnHeaders: true }),
    );
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=tok.sig");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.success", outcome: "success" }),
    );
  });

  it("rejects replayed nonces with 401 and audits the reason", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(false);
    const res = await POST(postRequest("abc"));
    expect(res.status).toBe(401);
    expect(createSsoSessionMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        reason: "nonce_replay_or_expired",
      }),
    );
  });

  it("forwards EACH Set-Cookie separately when Better Auth emits more than one (AUTH-3)", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(true);
    const multi = new Headers();
    multi.append("set-cookie", "better-auth.session_token=tok.sig; Path=/; HttpOnly");
    multi.append("set-cookie", "better-auth.dont_remember=1; Path=/; HttpOnly");
    createSsoSessionMock.mockResolvedValue({ headers: multi, response: { ok: true } });

    const res = await POST(postRequest("abc"));
    expect(res.status).toBe(303);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.every((c) => !c.includes(", better-auth"))).toBe(true);
  });

  it("returns 401 and audits when session establishment fails (e.g. banned user)", async () => {
    verifyMock.mockResolvedValue({ payload: { ...PAYLOAD, sub: "ba-banned" } });
    consumeMock.mockResolvedValue(true);
    createSsoSessionMock.mockRejectedValue(new Error("user is banned"));
    const res = await POST(postRequest("abc"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        outcome: "error",
        reason: "session_establishment_failed",
      }),
    );
  });

  it("rejects a POST with no token", async () => {
    const res = await POST(postRequest(null));
    expect(res.status).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe("application-id binding — token minted for another app (review #15)", () => {
  // A token whose `aud` matches (two registered apps sharing one audience) but
  // whose `targetApplicationId` names the OTHER app must be refused here.
  const FOREIGN = { ...PAYLOAD, targetApplicationId: "evil" };

  it("GET refuses it with 401 and audits target_application_mismatch (no confirm redirect)", async () => {
    verifyMock.mockResolvedValue({ payload: FOREIGN });
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        reason: "target_application_mismatch",
      }),
    );
  });

  it("POST refuses it with 401 BEFORE burning the nonce or creating a session", async () => {
    verifyMock.mockResolvedValue({ payload: FOREIGN });
    consumeMock.mockResolvedValue(true);
    const res = await POST(postRequest("abc"));
    expect(res.status).toBe(401);
    expect(consumeMock).not.toHaveBeenCalled();
    expect(createSsoSessionMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        reason: "target_application_mismatch",
      }),
    );
  });

  it("still accepts a token whose targetApplicationId equals SSO_HANDOFF_APPLICATION_ID", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sso/confirm");
  });
});

/**
 * Review #35 / #190: `/api/sso/consume` is NOT behind the proxy matcher, and
 * Better Auth reads the client IP for `session.ipAddress` from
 * `x-drk-client-ip` ONLY. The route must therefore derive that header itself
 * from the trusted hop — a client replaying its own handoff (curl) can
 * otherwise inject it — and the value must be the one the audit row records
 * (`getClientIp`, the same TRUSTED_PROXY_COUNT rule).
 */
describe("trusted client IP on session creation (review #35 / #190)", () => {
  /** What Better Auth's own resolver will record, given the headers the route passes. */
  function betterAuthIp(headers: Headers): string | null {
    return getIp(headers, {
      advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    } as BetterAuthOptions);
  }

  it("overwrites a client-injected x-drk-client-ip with the trusted hop; session IP === audit IP", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(true);
    const request = postRequest("abc", {
      [CLIENT_IP_HEADER]: "6.6.6.6",
      "x-forwarded-for": "6.6.6.6, 203.0.113.9",
    });
    expect((await POST(request)).status).toBe(303);

    const passed = createSsoSessionMock.mock.calls[0]![0].headers as Headers;
    // The attacker's value never reaches Better Auth; the edge-observed hop does.
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(betterAuthIp(passed)).toBe("203.0.113.9");
    // The route's own request object is not mutated (audit reads it later).
    expect(request.headers.get(CLIENT_IP_HEADER)).toBe("6.6.6.6");

    // The success audit row derives its ip from the SAME request with
    // `getClientIp` — the two must agree (the #190 divergence).
    const success = auditMock.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === "sso.consume.success",
    )!;
    const auditRequest = (success[0] as { request: NextRequest }).request;
    expect(getClientIp(auditRequest.headers)).toBe(passed.get(CLIENT_IP_HEADER));
  });

  it("an honest single-hop XFF (Vercel edge) still yields a real session IP", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(true);
    expect((await POST(postRequest("abc", { "x-forwarded-for": "203.0.113.9" }))).status).toBe(303);
    const passed = createSsoSessionMock.mock.calls[0]![0].headers as Headers;
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(betterAuthIp(passed)).toBe("203.0.113.9");
  });

  it("honors TRUSTED_PROXY_COUNT for a CDN + LB chain, like the audit row", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(true);
    const request = postRequest("abc", { "x-forwarded-for": "spoof, 203.0.113.9, 10.0.0.2" });
    expect((await POST(request)).status).toBe(303);
    const passed = createSsoSessionMock.mock.calls[0]![0].headers as Headers;
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(getClientIp(request.headers)).toBe("203.0.113.9");
  });

  it("strips an injected header when nothing trustworthy is present (fail closed, never the client's value)", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(true);
    expect((await POST(postRequest("abc", { [CLIENT_IP_HEADER]: "6.6.6.6" }))).status).toBe(303);
    const passed = createSsoSessionMock.mock.calls[0]![0].headers as Headers;
    expect(passed.has(CLIENT_IP_HEADER)).toBe(false);
    expect(betterAuthIp(passed)).not.toBe("6.6.6.6");
  });

  it("keeps the cookies / user-agent Better Auth needs on the forwarded copy", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(true);
    await POST(
      postRequest("abc", { cookie: "a=b", "user-agent": "ua", "x-real-ip": "203.0.113.9" }),
    );
    const passed = createSsoSessionMock.mock.calls[0]![0].headers as Headers;
    expect(passed.get("cookie")).toBe("a=b");
    expect(passed.get("user-agent")).toBe("ua");
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });
});

describe("per-IP rate limit (review #16)", () => {
  const ipA = { "x-forwarded-for": "203.0.113.9" };
  const ipB = { "x-forwarded-for": "198.51.100.4" };

  it("GET: an unauthenticated garbage-token flood from one IP hits 429 + Retry-After and stops writing audit rows", async () => {
    verifyMock.mockRejectedValue(new Error("signature_invalid"));
    // DEFAULT_SSO_CONSUME_LIMIT: 30-token burst.
    for (let i = 0; i < 30; i += 1) {
      expect((await GET(getRequest("http://localhost/api/sso/consume?token=zz", ipA))).status).toBe(
        401,
      );
    }
    expect(auditMock).toHaveBeenCalledTimes(30);
    auditMock.mockClear();
    verifyMock.mockClear();

    const denied = await GET(getRequest("http://localhost/api/sso/consume?token=zz", ipA));
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await denied.json()).toMatchObject({ error: "rate_limited" });
    expect(denied.headers.get("x-request-id")).toBeTruthy();
    // No verification and no `sso.consume.*` audit row for the denied call.
    expect(verifyMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure" }),
    );

    // Even a missing-token request is throttled before its audit write.
    auditMock.mockClear();
    const noToken = await GET(getRequest("http://localhost/api/sso/consume", ipA));
    expect(noToken.status).toBe(429);
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure" }),
    );

    // Another IP keeps its own budget.
    expect((await GET(getRequest("http://localhost/api/sso/consume?token=zz", ipB))).status).toBe(
      401,
    );
  });

  it("POST: shares the same per-IP scope and denies before the origin check / nonce burn", async () => {
    verifyMock.mockRejectedValue(new Error("signature_invalid"));
    for (let i = 0; i < 30; i += 1) {
      expect((await POST(postRequest("zz", ipA))).status).toBe(401);
    }
    consumeMock.mockClear();
    auditMock.mockClear();

    const denied = await POST(postRequest("zz", ipA));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect(consumeMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure" }),
    );
  });

  it("a legitimate single handoff (GET then POST) from a fresh IP is untouched", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue(true);
    expect((await GET(getRequest("http://localhost/api/sso/consume?token=abc", ipB))).status).toBe(
      307,
    );
    expect((await POST(postRequest("abc", ipB))).status).toBe(303);
  });
});
