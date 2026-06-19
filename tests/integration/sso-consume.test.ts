import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConsumeRouteModule from "@/app/api/sso/consume/route";
import type { NextRequest } from "next/server";

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

function getRequest(url: string): NextRequest {
  const u = new URL(url);
  return {
    nextUrl: u,
    url: u.toString(),
    method: "GET",
    headers: new Headers(),
  } as unknown as NextRequest;
}

function postRequest(token: string | null): NextRequest {
  const u = new URL("http://localhost/api/sso/consume");
  const form = new FormData();
  if (token !== null) form.set("token", token);
  return {
    nextUrl: u,
    url: u.toString(),
    method: "POST",
    headers: new Headers(),
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
    expect(consumeMock).toHaveBeenCalledWith("j1");
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
