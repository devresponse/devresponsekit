import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LaunchRouteModule from "@/app/api/sso/launch/route";
import type * as InMemoryLimiter from "@/lib/admin/rate-limit.server";
import type { NextRequest } from "next/server";
import { buildSsoLaunchReturnPath } from "@/lib/sso-launch-return";
import { getSafeReturnTo } from "@/lib/safe-return-to";

/**
 * Route integration tests for `/api/sso/launch` (§29.6.10).
 *
 * Mocks the auth-guard, the SSO redirect builder, and the audit module
 * so we can verify the route's contract: a missing / malformed
 * applicationId is rejected before any DB or audit work, unauthenticated
 * users are redirected to sign-in (logged, never audited — F-15),
 * impersonated sessions are refused
 * (review #4), launches are rate-limited per principal (review #16) — a
 * signed-out one from the shared bucket (F-19) — and successful launches set
 * `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
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
// F-15: the signed-out launch is logged, not audited.
const preAuthLog = vi.fn();
vi.mock("@/lib/observability/pre-auth-refusal.server", () => ({
  logPreAuthRefusal: (...args: unknown[]) => preAuthLog(...args),
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
// F-19: a SIGNED-OUT launch takes its per-IP bucket from the SHARED Postgres
// bucket; a signed-in one stays in the per-process bucket. No database here, so
// the shared primitives run on the real in-memory limiter of ONE module
// instance, held for the whole test. It survives `vi.resetModules()`, which
// hands a reloaded route a fresh per-process limiter the way a second warm
// lambda has one. Every key either primitive consumes is recorded, in order, so
// a deployment-wide key taken through `consumeSharedToken` (the tiered helper's
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
  preAuthLog.mockReset();
  logErrMock.mockReset();
  captureMock.mockReset();
  signerConfigured.value = true;
  shared.keys.length = 0;
  shared.limiter = undefined;
  // A fresh module graph per test also resets the in-memory limiter buckets.
  ({ GET } = await import("@/app/api/sso/launch/route"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

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

  it("redirects unauthenticated users to localized sign-in — logged, NOT audited (F-15)", async () => {
    sessionGetter.mockResolvedValue(null);
    const request = makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=fr");
    const res = await GET(request);
    expect(res.status).toBe(307);
    // Asserted exactly, not with `toContain`: a loose match passes whether or
    // not the return target is present, which would let the continuation this
    // redirect exists for regress silently.
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/fr/sign-in");
    expect(location.searchParams.get("returnTo")).toBe(
      "/fr/sso/launch?applicationId=portal&locale=fr",
    );
    expect(preAuthLog).toHaveBeenCalledWith({
      eventType: "sso.launch.failure",
      outcome: "failure",
      reason: "unauthenticated",
      request,
      metadata: { targetApplicationId: "portal" },
    });
    // No session, no one to attribute a row to: an anonymous loop must not
    // grow the append-only table.
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("never returns the signed-out user to an /api/ path", () => {
    // The sanitizer refuses `/api/` returnTo values; the route must therefore
    // hand sign-in a page path, or the continuation collapses to the dashboard.
    // Pinned here as well as in the unit suite because this is the caller that
    // has to honour it.
    const returnTo = buildSsoLaunchReturnPath("portal", "fr");
    expect(returnTo).toBe("/fr/sso/launch?applicationId=portal&locale=fr");
    expect(getSafeReturnTo(returnTo!, "fr")).toBe(returnTo);
  });

  it("falls back to the default locale when `locale` is unsupported", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(
      makeRequest("http://localhost/api/sso/launch?applicationId=portal&locale=zz"),
    );
    // The locale must narrow in BOTH positions — the redirect path and the
    // return target — or the user signs in under `en` and resumes under `zz`.
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/en/sign-in");
    expect(location.searchParams.get("returnTo")).toBe(
      "/en/sso/launch?applicationId=portal&locale=en",
    );
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
    // F-29: the log line and the Sentry event carry the id the 503 is stamped
    // with, so an operator holding the response can find both.
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logErrMock).toHaveBeenCalledWith(
      "sso.launch.config_error",
      expect.objectContaining({ reason: "signing_key_not_configured", requestId }),
    );
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith(expect.any(Error), { requestId, status: 503 });
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

  it("throttles the signed-out path per trusted client IP, and never audits it (F-15)", async () => {
    sessionGetter.mockResolvedValue(null);
    const fromIp = (ip: string) => makeRequest(url, { "x-forwarded-for": ip });

    for (let i = 0; i < 30; i += 1) {
      expect((await GET(fromIp("203.0.113.9"))).status).toBe(307);
    }
    expect(preAuthLog).toHaveBeenCalledTimes(30);
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.launch.failure" }),
    );
    preAuthLog.mockClear();
    const denied = await GET(fromIp("203.0.113.9"));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect(preAuthLog).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.launch.failure" }),
    );

    // A different IP still gets its own budget.
    expect((await GET(fromIp("198.51.100.4"))).status).toBe(307);
  });
});

/**
 * F-19: the signed-out branch was keyed on the client IP in the per-process
 * bucket, so a flood spread over N warm instances got N times the per-IP
 * budget. The two branches are now two limits: signed in stays per user in
 * this process, signed out takes a per-IP bucket from the SHARED store. There
 * is no deployment-wide floor behind it: a signed-out launch is how a real
 * user reaches sign-in, and it costs only a redirect and a log line (F-15).
 */
describe("GET /api/sso/launch — signed-out launches use the shared bucket (F-19)", () => {
  const url = "http://localhost/api/sso/launch?applicationId=portal&locale=en";
  const fromIp = (ip: string) => makeRequest(url, { "x-forwarded-for": ip });
  const KEY_A = "sso.launch.signed_out:ip:203.0.113.9";
  /** The i-th of a run of distinct client IPs. */
  const freshIp = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

  /** Freeze the clock at the real time, so no bucket refills mid-flood. */
  function freezeClock(): void {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  }

  it("a signed-out launch consults the shared limiter, keyed on the client IP alone", async () => {
    sessionGetter.mockResolvedValue(null);
    expect((await GET(fromIp("203.0.113.9"))).status).toBe(307);
    expect(shared.keys).toEqual([KEY_A]);
  });

  it("a signed-in launch stays per user in the per-process bucket and never touches the shared one", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    createRedirect.mockResolvedValue(
      new URL("https://portal.devresponse.com/api/sso/consume?token=abc"),
    );
    expect((await GET(fromIp("203.0.113.9"))).status).toBe(307);
    expect(shared.keys).toEqual([]);
    const inMemory = await import("@/lib/admin/rate-limit.server");
    expect(inMemory.__rateLimitBucketKeysForTests()).toContain("sso.launch:ba-1");
  });

  it("a signed-out flood spread over two warm instances gets ONE per-IP budget, not one each", async () => {
    freezeClock();
    sessionGetter.mockResolvedValue(null);
    const instanceA = GET;
    vi.resetModules();
    const { GET: instanceB } = await import("@/app/api/sso/launch/route");

    // DEFAULT_SSO_LAUNCH_LIMIT: 30-token burst, 15 through each instance.
    for (let i = 0; i < 30; i += 1) {
      const get = i % 2 === 0 ? instanceA : instanceB;
      expect((await get(fromIp("203.0.113.9"))).status).toBe(307);
    }
    // Kept per process, each instance had spent 15 of its own 30.
    for (const get of [instanceA, instanceB]) {
      const denied = await get(fromIp("203.0.113.9"));
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(await denied.json()).toMatchObject({ error: "rate_limited" });
    }
    expect(preAuthLog).toHaveBeenCalledTimes(30);
    expect(new Set(shared.keys)).toEqual(new Set([KEY_A]));
  });

  it("many signed-out sources at their full per-IP rate never lock out another IP, signed out or in", async () => {
    freezeClock();
    sessionGetter.mockResolvedValue(null);
    // 45 sources each spend their whole burst in the same instant (1,350
    // admitted launches), then are refused. A deployment-wide floor sized
    // anywhere near real launch volume would now be at zero.
    const SOURCES = 45;
    for (let s = 0; s < SOURCES; s += 1) {
      for (let i = 0; i < 30; i += 1) expect((await GET(fromIp(freshIp(s)))).status).toBe(307);
      expect((await GET(fromIp(freshIp(s)))).status).toBe(429);
    }

    // A real user on a different IP still reaches sign-in.
    const toSignIn = await GET(fromIp("198.51.100.4"));
    expect(toSignIn.status).toBe(307);
    expect(toSignIn.headers.get("location")).toContain("/sign-in");

    // No deployment-wide key was consulted at all: only the per-IP buckets.
    expect(shared.keys.filter((k) => k.includes("__global__"))).toEqual([]);
    const perIp = [
      ...Array.from({ length: SOURCES }, (_, s) => `sso.launch.signed_out:ip:${freshIp(s)}`),
      "sso.launch.signed_out:ip:198.51.100.4",
    ];
    expect(new Set(shared.keys)).toEqual(new Set(perIp));

    // And a signed-in launch from a flooding IP is keyed on its user, not there.
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    createRedirect.mockResolvedValue(
      new URL("https://portal.devresponse.com/api/sso/consume?token=abc"),
    );
    const signedIn = await GET(fromIp(freshIp(0)));
    expect(signedIn.status).toBe(307);
    expect(signedIn.headers.get("location")).toContain("portal.devresponse.com");
    expect(new Set(shared.keys)).toEqual(new Set(perIp));
  });
});
