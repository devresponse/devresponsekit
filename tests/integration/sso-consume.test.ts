import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConsumeRouteModule from "@/app/api/sso/consume/route";
import type * as InMemoryLimiter from "@/lib/admin/rate-limit.server";
import { NextRequest } from "next/server";
import { errors as joseErrors } from "jose";
import type { BetterAuthOptions } from "better-auth";
import { getIP } from "better-auth/api";
import { CLIENT_IP_HEADER, getClientIp } from "@/lib/client-ip";
import { meteredBody } from "../helpers/request-body";

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
// F-15: a refusal decided before the token verifies is logged, not audited.
const preAuthLog = vi.fn();
vi.mock("@/lib/observability/pre-auth-refusal.server", () => ({
  logPreAuthRefusal: (...args: unknown[]) => preAuthLog(...args),
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
// F-19: both methods take their per-IP bucket from the SHARED Postgres bucket.
// There is no database here, so the shared primitives run on the real
// in-memory limiter of ONE module instance, held for the whole test. It
// survives `vi.resetModules()`, which hands a reloaded route a fresh
// per-process limiter the way a second warm lambda has one, so a test can load
// the route twice to stand in for two instances and still see one shared
// budget. Every key either primitive consumes is recorded, in order, so a
// deployment-wide key taken through `consumeSharedToken` (the tiered helper's
// route) would be seen too.
const shared = vi.hoisted(() => ({
  keys: [] as string[],
  limiter: undefined as undefined | typeof InMemoryLimiter,
}));
vi.mock("@/lib/admin/rate-limit-shared.server", () => {
  const limiter = async () => (shared.limiter ??= await import("@/lib/admin/rate-limit.server"));
  return {
    consumeSharedToken: async (
      key: string,
      options: InMemoryLimiter.RateLimitOptions,
      nowMs?: number,
    ) => {
      shared.keys.push(key);
      return (await limiter()).consumeToken(key, options, nowMs);
    },
    enforceSharedRateLimit: async (
      ...args: Parameters<typeof InMemoryLimiter.enforceRateLimit>
    ) => {
      shared.keys.push(`${args[0]}:${args[1]}`);
      return (await limiter()).enforceRateLimit(...args);
    },
  };
});
// Review #66: the origin guard short-circuits under NODE_ENV=test, so the
// POST's origin-denied branch (403 + `denied` audit) was dead under the whole
// suite. Mock it (default: allow) so the deny path can be driven explicitly.
const originCheck = vi.fn();
vi.mock("@/lib/admin/origin-guard.server", () => ({
  checkTrustedOrigin: (...args: unknown[]) => originCheck(...args),
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

/**
 * The confirmation page's form POST, as a browser sends it: a urlencoded body
 * the route reads through its byte cap (F-78).
 */
function postRequest(
  token: string | null,
  headers: Record<string, string> = {},
  url = "http://localhost/api/sso/consume",
): NextRequest {
  const form = new URLSearchParams();
  if (token !== null) form.set("token", token);
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: form,
  });
}

// The minimised claim set (review #60): no organizationId / appUserId / roles.
const PAYLOAD = {
  jti: "j1",
  sub: "ba-1",
  targetApplicationId: "portal",
  email: "u@x.com",
  locale: "fr",
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
    preAuthLog,
    createSsoSessionMock,
    logErrMock,
    captureMock,
  ])
    m.mockReset();
  originCheck.mockReset().mockReturnValue({ ok: true });
  shared.keys.length = 0;
  shared.limiter = undefined;
  createSsoSessionMock.mockResolvedValue({
    headers: new Headers([["set-cookie", "better-auth.session_token=tok.sig; Path=/; HttpOnly"]]),
    response: { ok: true },
  });
  process.env.SSO_HANDOFF_AUDIENCE_PREFIX = "devresponse-app";
  process.env.SSO_HANDOFF_APPLICATION_ID = "portal";
  ({ GET, POST } = await import("@/app/api/sso/consume/route"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllEnvs();
  delete process.env.SSO_HANDOFF_APPLICATION_ID;
});

describe("GET /api/sso/consume — verify + confirmation redirect (P2-2)", () => {
  it("rejects requests without a token and logs the refusal WITHOUT an audit row (F-15)", async () => {
    const res = await GET(getRequest("http://localhost/api/sso/consume"));
    expect(res.status).toBe(400);
    const { requestId } = (await res.json()) as { requestId: string };
    expect(preAuthLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        outcome: "failure",
        reason: "missing_token",
        requestId,
      }),
    );
    expect(auditMock).not.toHaveBeenCalled();
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

  it("returns 401 and logs (does NOT audit) a token that fails verification (F-15)", async () => {
    verifyMock.mockRejectedValue(new Error("audience_mismatch"));
    const request = getRequest("http://localhost/api/sso/consume?token=abc");
    const res = await GET(request);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
    // An unverified token proves nothing about its sender — it may be random
    // bytes from a curl loop — so no append-only row.
    expect(preAuthLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        outcome: "failure",
        reason: "audience_mismatch",
        request,
        requestId: res.headers.get("x-request-id"),
      }),
    );
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/sso/consume — confirmed sign-in (P2-2)", () => {
  it("burns the nonce, establishes the session, and 303s to the dashboard with the cookie", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
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
    consumeMock.mockResolvedValue("replayed");
    const res = await POST(postRequest("abc"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "token_already_used" });
    expect(createSsoSessionMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        reason: "nonce_replay",
      }),
    );
    // A replay of a VERIFIED token stays audited (F-15 only moves refusals
    // decided before verification).
    expect(preAuthLog).not.toHaveBeenCalled();
  });

  it("forwards EACH Set-Cookie separately when Better Auth emits more than one (AUTH-3)", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
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
    consumeMock.mockResolvedValue("consumed");
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

  it("rejects a POST with no token (logged, not audited — F-15)", async () => {
    const res = await POST(postRequest(null));
    expect(res.status).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(preAuthLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure", reason: "missing_token" }),
    );
    expect(auditMock).not.toHaveBeenCalled();
  });

  describe("F-78: the form is read through a 16 KiB cap", () => {
    const CAP = 16 * 1024;
    const raw = (body: string | ReadableStream<Uint8Array>, headers?: Record<string, string>) =>
      new NextRequest("http://localhost/api/sso/consume", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body,
        duplex: "half",
      } as ConstructorParameters<typeof NextRequest>[1]);

    it("413s a declared oversize form unread: logged, not audited, nothing verified", async () => {
      const request = raw(`token=${"a".repeat(CAP)}`, { "content-length": String(CAP + 6) });
      const res = await POST(request);
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: string; requestId: string };
      expect(body.error).toBe("payload_too_large");
      expect(request.bodyUsed).toBe(false);
      expect(preAuthLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "sso.consume.failure",
          outcome: "failure",
          reason: "payload_too_large",
          requestId: body.requestId,
        }),
      );
      expect(verifyMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it("413s an undeclared (chunked) oversize form at the cap", async () => {
      const metered = meteredBody(4 * 1024, 64);
      expect((await POST(raw(metered.stream))).status).toBe(413);
      expect(metered.pulled).toBe(5);
      expect(metered.cancelled).toBe(true);
      expect(verifyMock).not.toHaveBeenCalled();
    });

    it("still reads the token from a form padded to the cap, and from a multipart form", async () => {
      verifyMock.mockResolvedValue({ payload: PAYLOAD });
      consumeMock.mockResolvedValue("consumed");
      const padded = `token=abc&pad=${"x".repeat(CAP - "token=abc&pad=".length)}`;
      expect((await POST(raw(padded))).status).toBe(303);

      const multipart = new FormData();
      multipart.set("token", "abc");
      const res = await POST(
        new NextRequest("http://localhost/api/sso/consume", { method: "POST", body: multipart }),
      );
      expect(res.status).toBe(303);
      expect(verifyMock).toHaveBeenLastCalledWith(expect.objectContaining({ token: "abc" }));
    });
  });

  it("POST: a token that fails verification is logged, not audited, and burns nothing (F-15)", async () => {
    verifyMock.mockRejectedValue(new Error("signature verification failed"));
    const res = await POST(postRequest("zz"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
    expect(preAuthLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.consume.failure",
        outcome: "failure",
        reason: "signature verification failed",
      }),
    );
    expect(auditMock).not.toHaveBeenCalled();
    expect(consumeMock).not.toHaveBeenCalled();
    expect(createSsoSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["untrusted_origin", "https://evil.example"],
    ["missing_origin", null],
  ] as const)(
    "refuses a cross-site confirm (%s) with 403 BEFORE reading the token — logged, NOT audited (review #66, P2-2, F-15)",
    async (reason, origin) => {
      originCheck.mockReturnValue({ ok: false, reason });
      verifyMock.mockResolvedValue({ payload: PAYLOAD });
      consumeMock.mockResolvedValue("consumed");
      const request = postRequest("abc", origin ? { origin } : {});
      const res = await POST(request);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; requestId: string };
      expect(body.error).toBe("forbidden");
      expect(res.headers.get("x-request-id")).toBe(body.requestId);
      // The guard saw THIS request (the same object the log line cites).
      expect(originCheck).toHaveBeenCalledWith(request);
      expect(preAuthLog).toHaveBeenCalledTimes(1);
      expect(preAuthLog).toHaveBeenCalledWith({
        eventType: "sso.consume.failure",
        outcome: "denied",
        reason,
        request,
        requestId: body.requestId,
      });
      // Refused before anything about the sender is verified: no row.
      expect(auditMock).not.toHaveBeenCalled();
      // The login-CSRF defence: nothing past the gate ran — no token read,
      // no verification, no nonce burn, no session, no cookie.
      expect(verifyMock).not.toHaveBeenCalled();
      expect(consumeMock).not.toHaveBeenCalled();
      expect(createSsoSessionMock).not.toHaveBeenCalled();
      expect(res.headers.get("set-cookie")).toBeNull();
    },
  );

  it("does NOT apply the origin gate to the GET verify step (the interstitial is IdP-initiated by design)", async () => {
    originCheck.mockReturnValue({ ok: false, reason: "untrusted_origin" });
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc"));
    expect(res.status).toBe(307);
    expect(originCheck).not.toHaveBeenCalled();
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
    // F-15 draws the line at verification: this token is GENUINE (the issuer
    // minted it for another app), so the refusal keeps its audit row.
    expect(preAuthLog).not.toHaveBeenCalled();
  });

  it("POST refuses it with 401 BEFORE burning the nonce or creating a session", async () => {
    verifyMock.mockResolvedValue({ payload: FOREIGN });
    consumeMock.mockResolvedValue("consumed");
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
    return getIP(headers, {
      advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    } as BetterAuthOptions);
  }

  it("overwrites a client-injected x-drk-client-ip with the trusted hop; session IP === audit IP", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
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
    consumeMock.mockResolvedValue("consumed");
    expect((await POST(postRequest("abc", { "x-forwarded-for": "203.0.113.9" }))).status).toBe(303);
    const passed = createSsoSessionMock.mock.calls[0]![0].headers as Headers;
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(betterAuthIp(passed)).toBe("203.0.113.9");
  });

  it("honors TRUSTED_PROXY_COUNT for a CDN + LB chain, like the audit row", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
    const request = postRequest("abc", { "x-forwarded-for": "spoof, 203.0.113.9, 10.0.0.2" });
    expect((await POST(request)).status).toBe(303);
    const passed = createSsoSessionMock.mock.calls[0]![0].headers as Headers;
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(getClientIp(request.headers)).toBe("203.0.113.9");
  });

  it("strips an injected header when nothing trustworthy is present (fail closed, never the client's value)", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
    expect((await POST(postRequest("abc", { [CLIENT_IP_HEADER]: "6.6.6.6" }))).status).toBe(303);
    const passed = createSsoSessionMock.mock.calls[0]![0].headers as Headers;
    expect(passed.has(CLIENT_IP_HEADER)).toBe(false);
    expect(betterAuthIp(passed)).not.toBe("6.6.6.6");
  });

  it("keeps the cookies / user-agent Better Auth needs on the forwarded copy", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
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

  it("GET: an unauthenticated garbage-token flood from one IP writes NO audit rows and hits 429 + Retry-After", async () => {
    verifyMock.mockRejectedValue(new Error("signature_invalid"));
    // DEFAULT_SSO_CONSUME_LIMIT: 30-token burst.
    for (let i = 0; i < 30; i += 1) {
      expect((await GET(getRequest("http://localhost/api/sso/consume?token=zz", ipA))).status).toBe(
        401,
      );
    }
    // F-15: the limiter used to let every one of these through to the
    // append-only table (~86k rows/day per IP). Each is now a log line.
    expect(auditMock).not.toHaveBeenCalled();
    expect(preAuthLog).toHaveBeenCalledTimes(30);
    preAuthLog.mockClear();
    verifyMock.mockClear();

    const denied = await GET(getRequest("http://localhost/api/sso/consume?token=zz", ipA));
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await denied.json()).toMatchObject({ error: "rate_limited" });
    expect(denied.headers.get("x-request-id")).toBeTruthy();
    // No verification and no `sso.consume.*` record for the denied call.
    expect(verifyMock).not.toHaveBeenCalled();
    expect(preAuthLog).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure" }),
    );

    // Even a missing-token request is throttled before it is recorded.
    const noToken = await GET(getRequest("http://localhost/api/sso/consume", ipA));
    expect(noToken.status).toBe(429);
    expect(preAuthLog).not.toHaveBeenCalled();
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
    // F-15: none of the 30 refusals reached the audit table.
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure" }),
    );
    consumeMock.mockClear();
    preAuthLog.mockClear();

    const denied = await POST(postRequest("zz", ipA));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect(consumeMock).not.toHaveBeenCalled();
    expect(preAuthLog).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.consume.failure" }),
    );
  });

  it("a legitimate single handoff (GET then POST) from a fresh IP is untouched", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
    expect((await GET(getRequest("http://localhost/api/sso/consume?token=abc", ipB))).status).toBe(
      307,
    );
    expect((await POST(postRequest("abc", ipB))).status).toBe(303);
  });
});

/**
 * F-19: the per-IP budget lived in the per-process bucket, so a garbage-token
 * flood spread over N warm instances got N times it per IP. Both methods now
 * take the IP's bucket from the SHARED store, and nothing else: there is
 * deliberately no deployment-wide floor, because it would answer 429 before
 * the token is verified and so refuse genuine handoffs exactly like garbage
 * ones, and a few dozen sources could hold it at zero for every user.
 */
describe("F-19: consume is limited per IP from the shared bucket, with no global floor", () => {
  const ipA = { "x-forwarded-for": "203.0.113.9" };
  const KEY_A = "sso.consume:ip:203.0.113.9";
  const garbage = (headers: Record<string, string>) =>
    getRequest("http://localhost/api/sso/consume?token=zz", headers);
  /** The i-th of a run of distinct client IPs. */
  const freshIp = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

  /** Freeze the clock at the real time, so no bucket refills mid-flood. */
  function freezeClock(): void {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  }

  it("GET and POST consult the shared limiter, keyed on the client IP alone", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
    expect((await GET(getRequest("http://localhost/api/sso/consume?token=abc", ipA))).status).toBe(
      307,
    );
    expect(shared.keys).toEqual([KEY_A]);

    shared.keys.length = 0;
    expect((await POST(postRequest("abc", ipA))).status).toBe(303);
    expect(shared.keys).toEqual([KEY_A]);
  });

  it("a flood spread over two warm instances gets ONE per-IP budget, not one each", async () => {
    freezeClock();
    verifyMock.mockRejectedValue(new Error("signature_invalid"));
    // A second instance: a fresh module graph, so a fresh per-process limiter.
    const instanceA = GET;
    vi.resetModules();
    const { GET: instanceB } = await import("@/app/api/sso/consume/route");

    // DEFAULT_SSO_CONSUME_LIMIT: 30-token burst, 15 through each instance.
    for (let i = 0; i < 30; i += 1) {
      const get = i % 2 === 0 ? instanceA : instanceB;
      expect((await get(garbage(ipA))).status).toBe(401);
    }
    // Kept per process, each instance had spent 15 of its own 30 and would
    // admit both of these.
    for (const get of [instanceA, instanceB]) {
      const denied = await get(garbage(ipA));
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(await denied.json()).toMatchObject({ error: "rate_limited" });
      expect(denied.headers.get("x-request-id")).toBeTruthy();
    }
    expect(verifyMock).toHaveBeenCalledTimes(30);
    expect(new Set(shared.keys)).toEqual(new Set([KEY_A]));
  });

  it("many sources flooding at their full per-IP rate never lock out a genuine handoff from another IP", async () => {
    freezeClock();
    verifyMock.mockRejectedValue(new Error("signature_invalid"));
    // 45 sources each spend their whole burst in the same instant (1,350
    // admitted garbage tokens), then are refused. A deployment-wide floor
    // sized anywhere near real handoff volume would now be at zero.
    const SOURCES = 45;
    for (let s = 0; s < SOURCES; s += 1) {
      const from = { "x-forwarded-for": freshIp(s) };
      for (let i = 0; i < 30; i += 1) expect((await GET(garbage(from))).status).toBe(401);
      expect((await GET(garbage(from))).status).toBe(429);
    }

    // A real user on a different IP completes the handoff: GET, then POST.
    verifyMock.mockReset().mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
    const victim = { "x-forwarded-for": "198.51.100.4" };
    expect(
      (await GET(getRequest("http://localhost/api/sso/consume?token=abc", victim))).status,
    ).toBe(307);
    expect((await POST(postRequest("abc", victim))).status).toBe(303);
    expect(createSsoSessionMock).toHaveBeenCalledTimes(1);

    // No deployment-wide key was consulted at all: only the per-IP buckets.
    expect(shared.keys.filter((k) => k.includes("__global__"))).toEqual([]);
    const perIp = [
      ...Array.from({ length: SOURCES }, (_, s) => `sso.consume:ip:${freshIp(s)}`),
      "sso.consume:ip:198.51.100.4",
    ];
    expect(new Set(shared.keys)).toEqual(new Set(perIp));
  });
});

/**
 * F-85: a failed handoff showed the person a bare JSON body, most often
 * `token_already_used` after they read the confirm page for longer than the
 * token lives, which was really an expiry. A browser (it names `text/html` in
 * `Accept`) is now sent to the confirm page's failure state; every other caller
 * keeps the JSON; and an expiry is reported as `token_expired`, from jose's
 * `JWTExpired` or from the nonce row, never as a replay.
 */
describe("F-85: failures send a browser to the confirm page, and an expiry is not a replay", () => {
  /** What a browser sends on a top-level navigation and on a form POST. */
  const BROWSER = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  /** An expiry as jose raises it: signature, issuer and audience already checked out. */
  const expired = () =>
    new joseErrors.JWTExpired('"exp" claim timestamp check failed', {}, "exp", "check_failed");

  /** Asserts the 303 to the failure page and returns where it points. */
  function failurePage(res: Response): URL {
    expect(res.status).toBe(303);
    const page = new URL(res.headers.get("location")!);
    expect(page.pathname).toMatch(/^\/[a-z]{2}\/sso\/confirm$/);
    // The page shows the id the response header and the log line carry.
    expect(page.searchParams.get("requestId")).toBe(res.headers.get("x-request-id"));
    // The token never rides the failure redirect, and nothing signs in.
    expect(page.searchParams.has("token")).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    return page;
  }

  it("GET: a token that fails verification sends a browser to the invalid state, logged and not audited", async () => {
    verifyMock.mockRejectedValue(new Error("signature verification failed"));
    const page = failurePage(
      await GET(getRequest("http://localhost/api/sso/consume?token=abc", BROWSER)),
    );
    // Nothing verified names a locale, so the default one.
    expect(page.pathname).toBe("/en/sso/confirm");
    expect(page.searchParams.get("error")).toBe("invalid_token");
    expect(preAuthLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "signature verification failed" }),
    );
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("GET: a missing token lands in the `locale` query parameter's language", async () => {
    const page = failurePage(
      await GET(getRequest("http://localhost/api/sso/consume?locale=uk", BROWSER)),
    );
    expect(page.pathname).toBe("/uk/sso/confirm");
    expect(page.searchParams.get("error")).toBe("missing_token");
  });

  it("GET: a verified token for another app lands in the token's own locale, still audited", async () => {
    verifyMock.mockResolvedValue({ payload: { ...PAYLOAD, targetApplicationId: "evil" } });
    const page = failurePage(
      await GET(getRequest("http://localhost/api/sso/consume?token=abc", BROWSER)),
    );
    expect(page.pathname).toBe("/fr/sso/confirm");
    expect(page.searchParams.get("error")).toBe("invalid_token");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "target_application_mismatch" }),
    );
  });

  it("GET: a browser's valid handoff still goes to the confirm step with its token", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc", BROWSER));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).searchParams.get("token")).toBe("abc");
  });

  it.each([
    ["replayed", "token_already_used", "nonce_replay"],
    ["expired", "token_expired", "nonce_expired"],
    ["unknown", "invalid_token", "nonce_unknown"],
  ] as const)(
    "POST: a nonce burn that missed as %s answers %s and audits %s",
    async (burn, code, reason) => {
      verifyMock.mockResolvedValue({ payload: PAYLOAD });
      consumeMock.mockResolvedValue(burn);

      const api = await POST(postRequest("abc"));
      expect(api.status).toBe(401);
      expect(await api.json()).toMatchObject({ error: code });
      expect(auditMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ eventType: "sso.consume.failure", outcome: "failure", reason }),
      );

      const page = failurePage(await POST(postRequest("abc", BROWSER)));
      expect(page.pathname).toBe("/fr/sso/confirm");
      expect(page.searchParams.get("error")).toBe(code);
      expect(createSsoSessionMock).not.toHaveBeenCalled();
    },
  );

  it("an expired token (jose JWTExpired) answers token_expired on both methods, logged and not audited", async () => {
    verifyMock.mockRejectedValue(expired());
    const get = await GET(getRequest("http://localhost/api/sso/consume?token=abc"));
    expect(get.status).toBe(401);
    expect(await get.json()).toMatchObject({ error: "token_expired" });
    const post = await POST(postRequest("abc"));
    expect(post.status).toBe(401);
    expect(await post.json()).toMatchObject({ error: "token_expired" });
    // Still refused before the token verified (F-15): a log line, no row, no burn.
    expect(preAuthLog).toHaveBeenCalledTimes(2);
    expect(preAuthLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: '"exp" claim timestamp check failed' }),
    );
    expect(auditMock).not.toHaveBeenCalled();
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it("any other verification failure, a failed claim check included, stays invalid_token", async () => {
    verifyMock.mockRejectedValue(
      new joseErrors.JWTClaimValidationFailed('unexpected "aud" claim value', {}, "aud"),
    );
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc"));
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });

  it("POST: a token that expired on the confirm page comes back to it in the form's locale", async () => {
    verifyMock.mockRejectedValue(expired());
    const page = failurePage(
      await POST(postRequest("abc", BROWSER, "http://localhost/api/sso/consume?locale=uk")),
    );
    expect(page.pathname).toBe("/uk/sso/confirm");
    expect(page.searchParams.get("error")).toBe("token_expired");
  });

  it("POST: a failed session and a refused origin send a browser to the page too", async () => {
    verifyMock.mockResolvedValue({ payload: PAYLOAD });
    consumeMock.mockResolvedValue("consumed");
    createSsoSessionMock.mockRejectedValue(new Error("user is banned"));
    const failed = failurePage(await POST(postRequest("abc", BROWSER)));
    expect(failed.searchParams.get("error")).toBe("session_establishment_failed");

    originCheck.mockReturnValue({ ok: false, reason: "untrusted_origin" });
    const refused = failurePage(await POST(postRequest("abc", BROWSER)));
    expect(refused.searchParams.get("error")).toBe("forbidden");
  });

  it("a rate-limited browser goes to the page; an API client keeps the 429 and Retry-After", async () => {
    // Freeze the clock so no token refills mid-burst.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    verifyMock.mockRejectedValue(new Error("signature_invalid"));
    const ip = { "x-forwarded-for": "203.0.113.77" };
    const garbage = (headers: Record<string, string>) =>
      getRequest("http://localhost/api/sso/consume?token=zz", headers);
    for (let i = 0; i < 30; i += 1) expect((await GET(garbage(ip))).status).toBe(401);

    const api = await GET(garbage(ip));
    expect(api.status).toBe(429);
    expect(api.headers.get("retry-after")).toBeTruthy();
    const page = failurePage(await GET(garbage({ ...ip, ...BROWSER })));
    expect(page.searchParams.get("error")).toBe("rate_limited");
  });

  it.each([
    ["no Accept header", {}],
    ["a wildcard (curl, Node fetch, the drk-deploy probe)", { accept: "*/*" }],
    ["application/json", { accept: "application/json" }],
    ["JSON named alongside HTML", { accept: "text/html, application/json" }],
  ])("keeps the JSON body for %s", async (_label, headers) => {
    verifyMock.mockRejectedValue(new Error("signature verification failed"));
    const res = await GET(getRequest("http://localhost/api/sso/consume?token=abc", headers));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });
});
