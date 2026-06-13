import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConsumeRouteModule from "@/app/api/sso/consume/route";
import type { NextRequest } from "next/server";

/**
 * Route integration tests for `/api/sso/consume` (§29.6.10 + §29.7.5).
 *
 * Verifies the consumer's contract: missing token is audited and
 * rejected, missing audience config returns 500, replayed nonces are
 * rejected with 401, and successful consumption sets the documented
 * security headers.
 */

const verifyMock = vi.fn();
const consumeMock = vi.fn();
const auditMock = vi.fn();
const createSsoSessionMock = vi.fn();

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

function makeRequest(url: string): NextRequest {
  const u = new URL(url);
  return { nextUrl: u, url: u.toString(), headers: new Headers() } as unknown as NextRequest;
}

let GET: typeof ConsumeRouteModule.GET;

beforeEach(async () => {
  verifyMock.mockReset();
  consumeMock.mockReset();
  auditMock.mockReset();
  createSsoSessionMock.mockReset();
  createSsoSessionMock.mockResolvedValue({
    headers: new Headers([["set-cookie", "better-auth.session_token=tok.sig; Path=/; HttpOnly"]]),
    response: { ok: true },
  });
  process.env.SSO_HANDOFF_AUDIENCE_PREFIX = "devresponse-app";
  process.env.SSO_HANDOFF_APPLICATION_ID = "portal";
  ({ GET } = await import("@/app/api/sso/consume/route"));
});
afterEach(() => {
  vi.resetModules();
  delete process.env.SSO_HANDOFF_APPLICATION_ID;
});

describe("GET /api/sso/consume", () => {
  it("rejects requests without a token and audits the failure", async () => {
    const res = await GET(makeRequest("http://localhost/api/sso/consume"));
    expect(res.status).toBe(400);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        reason: "missing_token",
      }),
    );
  });

  it("returns 500 if the application id is not configured", async () => {
    delete process.env.SSO_HANDOFF_APPLICATION_ID;
    const res = await GET(makeRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(500);
  });

  it("rejects replayed nonces with 401 and audits the reason", async () => {
    verifyMock.mockResolvedValue({
      payload: {
        jti: "j1",
        sub: "ba-1",
        targetApplicationId: "portal",
        email: "u@x.com",
        organizationId: "o-1",
        appUserId: "u-1",
        locale: "en",
        roles: [],
        iat: 0,
        exp: 60,
      },
    });
    consumeMock.mockResolvedValue(false);
    const res = await GET(makeRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(401);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        reason: "nonce_replay_or_expired",
      }),
    );
  });

  it("redirects to the localized dashboard with no-referrer + no-store on success", async () => {
    verifyMock.mockResolvedValue({
      payload: {
        jti: "j2",
        sub: "ba-1",
        targetApplicationId: "portal",
        email: "u@x.com",
        organizationId: "o-1",
        appUserId: "u-1",
        locale: "fr",
        roles: ["member"],
        iat: 0,
        exp: 60,
      },
    });
    consumeMock.mockResolvedValue(true);
    const res = await GET(makeRequest("http://localhost/api/sso/consume?token=abc&locale=fr"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/fr/app/dashboard");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.success",
        outcome: "success",
      }),
    );
  });

  it("establishes a session for the verified sub and forwards the cookie", async () => {
    verifyMock.mockResolvedValue({
      payload: {
        jti: "j3",
        sub: "ba-9",
        targetApplicationId: "portal",
        email: "u@x.com",
        organizationId: "o-1",
        appUserId: "u-1",
        locale: "en",
        roles: [],
        iat: 0,
        exp: 60,
      },
    });
    consumeMock.mockResolvedValue(true);
    const res = await GET(makeRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(307);
    expect(createSsoSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "ba-9" }, returnHeaders: true }),
    );
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=tok.sig");
  });

  it("returns 401 and audits when session establishment fails (e.g. banned user)", async () => {
    verifyMock.mockResolvedValue({
      payload: {
        jti: "j4",
        sub: "ba-banned",
        targetApplicationId: "portal",
        email: "u@x.com",
        organizationId: "o-1",
        appUserId: "u-1",
        locale: "en",
        roles: [],
        iat: 0,
        exp: 60,
      },
    });
    consumeMock.mockResolvedValue(true);
    createSsoSessionMock.mockRejectedValue(new Error("user is banned"));
    const res = await GET(makeRequest("http://localhost/api/sso/consume?token=abc"));
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

  it("returns 401 and audits the verification failure reason", async () => {
    verifyMock.mockRejectedValue(new Error("audience_mismatch"));
    const res = await GET(makeRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(401);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        reason: "audience_mismatch",
      }),
    );
  });
});
