import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { BetterAuthOptions } from "better-auth";
import { getIP } from "better-auth/api";
import type * as ProxyModule from "@/proxy";
import { CLIENT_IP_HEADER, applyClientIpHeader, getClientIp } from "@/lib/client-ip";

/**
 * Trusted client-IP header in `proxy.ts` (review #35).
 *
 * Better Auth's built-in limiter (sign-in 3/10 s, reset 3/60 s) and
 * `session.ipAddress` used to read `x-forwarded-for` with a single-value-only
 * trust rule: a multi-hop chain resolved to nothing (one deployment-wide
 * `no-trusted-ip` bucket) and a bare client-supplied value was trusted
 * verbatim. The proxy now derives the IP with the app's own
 * `TRUSTED_PROXY_COUNT` model and ALWAYS overwrites `x-drk-client-ip` on the
 * forwarded request; Better Auth reads only that header. These tests pin:
 * a client cannot inject the header, an N-hop chain resolves to the hop the
 * app trusts, `/api/auth/*` is matched, and Better Auth's resolver agrees
 * with `getClientIp` for the same inputs.
 */
const intlState = vi.hoisted(() => ({ captured: null as NextRequest | null }));
const guard = vi.hoisted(() => ({ session: "ba.session=x" as string | null, secure: false }));

vi.mock("next-intl/middleware", async () => {
  const { NextResponse } = await import("next/server");
  return {
    default: () => (req: NextRequest) => {
      intlState.captured = req;
      return NextResponse.next();
    },
  };
});
vi.mock("better-auth/cookies", () => ({ getSessionCookie: () => guard.session }));
vi.mock("@/config/route-regions", () => ({ isLocalizedSecurePath: () => guard.secure }));

let proxy: typeof ProxyModule.proxy;
let config: typeof ProxyModule.config;

const AUTH_PATH = "/api/auth/sign-in/email";

function req(pathname: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000${pathname}`), {
    method: pathname.startsWith("/api/") ? "POST" : "GET",
    headers,
  });
}

/**
 * `NextResponse.next({ request: { headers } })` carries the forwarded request
 * headers as `x-middleware-request-<name>` (listed in
 * `x-middleware-override-headers`) — that is how Next hands them to the route
 * handler, so it is what a route handler will actually observe.
 */
function forwardedHeader(res: Response, name: string): string | null {
  const overridden = (res.headers.get("x-middleware-override-headers") ?? "")
    .split(",")
    .map((s) => s.trim());
  expect(overridden).toContain(name);
  return res.headers.get(`x-middleware-request-${name}`);
}

/** The exact Better Auth option block `src/lib/auth.ts` passes. */
const betterAuthIpOptions = {
  advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
} as BetterAuthOptions;

beforeEach(async () => {
  intlState.captured = null;
  guard.session = "ba.session=x";
  guard.secure = false;
  ({ proxy, config } = await import("@/proxy"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("proxy — trusted client-IP header on the Better Auth catch-all", () => {
  it("matches /api/auth/* so the header is set before Better Auth's limiter runs", () => {
    expect(config.matcher).toContain("/api/auth/:path*");
    // The general page matcher still excludes the rest of /api.
    expect(config.matcher.some((m) => m.includes("(?!api|"))).toBe(true);
  });

  it("stamps the single-hop XFF entry (default TRUSTED_PROXY_COUNT=1)", () => {
    const res = proxy(req(AUTH_PATH, { "x-forwarded-for": "203.0.113.9" }));
    expect(forwardedHeader(res, CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("OVERWRITES a client-injected x-drk-client-ip with the trusted hop", () => {
    const res = proxy(
      req(AUTH_PATH, {
        [CLIENT_IP_HEADER]: "198.51.100.77",
        "x-forwarded-for": "198.51.100.77, 203.0.113.9",
      }),
    );
    // The attacker's value never reaches Better Auth; the edge-observed IP does.
    expect(forwardedHeader(res, CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("REMOVES a client-injected x-drk-client-ip when no IP can be trusted", () => {
    const res = proxy(req(AUTH_PATH, { [CLIENT_IP_HEADER]: "198.51.100.77" }));
    const overridden = res.headers.get("x-middleware-override-headers") ?? "";
    expect(overridden.split(",").map((s) => s.trim())).not.toContain(CLIENT_IP_HEADER);
    expect(res.headers.get(`x-middleware-request-${CLIENT_IP_HEADER}`)).toBeNull();
  });

  it("resolves an N-hop chain to the hop TRUSTED_PROXY_COUNT selects (CDN + LB)", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    const res = proxy(req(AUTH_PATH, { "x-forwarded-for": "spoof, 203.0.113.9, 10.0.0.2" }));
    expect(forwardedHeader(res, CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("ignores the spoofable leftmost entry behind one appending proxy", () => {
    const res = proxy(req(AUTH_PATH, { "x-forwarded-for": "spoof, 203.0.113.9" }));
    expect(forwardedHeader(res, CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip when there is no forwarded chain", () => {
    const res = proxy(req(AUTH_PATH, { "x-real-ip": "203.0.113.9" }));
    expect(forwardedHeader(res, CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("CLIENT_IP_SOURCE=x-real-ip: stamps X-Real-IP and ignores a client-sent X-Forwarded-For (F-17)", () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "x-real-ip");
    const res = proxy(
      req(AUTH_PATH, { "x-forwarded-for": "198.51.100.77", "x-real-ip": "203.0.113.9" }),
    );
    expect(forwardedHeader(res, CLIENT_IP_HEADER)).toBe("203.0.113.9");

    // Without the header the source names, the forged chain counts for nothing.
    const bare = proxy(
      req(AUTH_PATH, { [CLIENT_IP_HEADER]: "198.51.100.77", "x-forwarded-for": "198.51.100.77" }),
    );
    expect(bare.headers.get(`x-middleware-request-${CLIENT_IP_HEADER}`)).toBeNull();
  });

  it("stamps the NORMALIZED hop: port stripped, IPv4-mapped IPv6 mapped (F-16)", () => {
    const ported = proxy(req(AUTH_PATH, { "x-forwarded-for": "spoof, 203.0.113.9:51234" }));
    expect(forwardedHeader(ported, CLIENT_IP_HEADER)).toBe("203.0.113.9");
    const mapped = proxy(req(AUTH_PATH, { "x-forwarded-for": "[::ffff:203.0.113.9]:443" }));
    expect(forwardedHeader(mapped, CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("REMOVES the header when the trusted hop is not an IP address (F-16)", () => {
    const res = proxy(
      req(AUTH_PATH, { [CLIENT_IP_HEADER]: "198.51.100.77", "x-forwarded-for": "garbage" }),
    );
    const overridden = res.headers.get("x-middleware-override-headers") ?? "";
    expect(overridden.split(",").map((s) => s.trim())).not.toContain(CLIENT_IP_HEADER);
    expect(res.headers.get(`x-middleware-request-${CLIENT_IP_HEADER}`)).toBeNull();
  });

  it("keeps the enforcing CSP on the API branch", () => {
    const res = proxy(req(AUTH_PATH, { "x-forwarded-for": "203.0.113.9" }));
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});

describe("proxy — trusted client-IP header on page renders", () => {
  it("threads the header into the rendered request (server actions call auth.api.*)", () => {
    proxy(
      req("/en/sign-in", {
        [CLIENT_IP_HEADER]: "198.51.100.77",
        "x-forwarded-for": "198.51.100.77, 203.0.113.9",
      }),
    );
    expect(intlState.captured?.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("strips a client-injected header from the rendered request when untrusted", () => {
    proxy(req("/en/sign-in", { [CLIENT_IP_HEADER]: "198.51.100.77" }));
    expect(intlState.captured?.headers.get(CLIENT_IP_HEADER)).toBeNull();
  });
});

describe("Better Auth's resolver agrees with getClientIp for the same inputs", () => {
  const vectors: Array<{
    name: string;
    headers: Record<string, string>;
    proxies?: string;
    source?: string;
  }> = [
    { name: "single-hop chain", headers: { "x-forwarded-for": "203.0.113.9" } },
    {
      name: "spoofed leftmost + appending proxy",
      headers: { "x-forwarded-for": "198.51.100.77, 203.0.113.9" },
    },
    {
      name: "three-hop chain behind CDN + LB",
      headers: { "x-forwarded-for": "198.51.100.77, 203.0.113.9, 10.0.0.2" },
      proxies: "2",
    },
    { name: "x-real-ip fallback", headers: { "x-real-ip": "203.0.113.9" } },
    {
      name: "IPv4-mapped IPv6 (both sides map it to the IPv4, F-16)",
      headers: { "x-forwarded-for": "::ffff:203.0.113.9" },
    },
    {
      name: "IPv4 hop with the port a load balancer appended (F-16)",
      headers: { "x-forwarded-for": "198.51.100.77, 203.0.113.9:51234" },
    },
    {
      name: "port-suffixed x-real-ip fallback (F-16)",
      headers: { "x-real-ip": "203.0.113.9:8080" },
    },
    {
      name: "x-real-ip source beside a forged X-Forwarded-For (F-17)",
      headers: { "x-forwarded-for": "198.51.100.77", "x-real-ip": "203.0.113.9" },
      source: "x-real-ip",
    },
    {
      name: "cf-connecting-ip source beside forged X-Forwarded-For / X-Real-IP (F-17)",
      headers: {
        "x-forwarded-for": "198.51.100.77",
        "x-real-ip": "198.51.100.78",
        "cf-connecting-ip": "203.0.113.9",
      },
      source: "cf-connecting-ip",
    },
  ];

  for (const v of vectors) {
    it(`${v.name} → ${v.source ?? `${v.proxies ?? "1"} trusted hop(s)`}`, () => {
      if (v.proxies) vi.stubEnv("TRUSTED_PROXY_COUNT", v.proxies);
      if (v.source) vi.stubEnv("CLIENT_IP_SOURCE", v.source);
      const headers = new Headers(v.headers);
      const expected = getClientIp(headers);
      expect(expected).toBe("203.0.113.9");

      // What the proxy forwards…
      applyClientIpHeader(headers);
      // …resolves, through Better Auth's own resolver + the app's option
      // block, to the same client the app's limiter keys on. Before F-16 a
      // port-suffixed hop was forwarded raw, failed Better Auth's validation
      // and landed in its shared `no-trusted-ip` bucket (under NODE_ENV=test,
      // the localhost fallback).
      const resolved = getIP(headers, betterAuthIpOptions);
      expect(resolved).toBe(expected);
    });
  }

  it("a bracketed IPv6 hop with a port reaches Better Auth as that client's /64, not no-trusted-ip (F-16)", () => {
    const headers = new Headers({ "x-forwarded-for": "[2001:db8:1:2::abcd]:443" });
    applyClientIpHeader(headers);
    // The header carries the full address; Better Auth masks it to its
    // default /64 `ipv6Subnet` for its limiter and `session.ipAddress`.
    expect(headers.get(CLIENT_IP_HEADER)).toBe("2001:db8:1:2::abcd");
    expect(getIP(headers, betterAuthIpOptions)).toBe("2001:0db8:0001:0002:0000:0000:0000:0000");
  });

  it("Better Auth's DEFAULT x-forwarded-for read does NOT reach the trusted hop of a multi-hop chain", () => {
    // The pre-fix behaviour: with >1 token and no trustedProxies, Better Auth
    // resolves nothing (in production that is the shared `no-trusted-ip`
    // bucket; under NODE_ENV=test it falls back to localhost). Either way it
    // is not the client the app's own limiter would key on.
    const headers = new Headers({ "x-forwarded-for": "198.51.100.77, 203.0.113.9" });
    expect(getClientIp(headers)).toBe("203.0.113.9");
    expect(getIP(headers, {} as BetterAuthOptions)).not.toBe("203.0.113.9");
  });

  it("a client cannot pick its bucket: only the proxy-stamped header is read", () => {
    // Client injects both a bare XFF (trusted verbatim by the old default
    // read) and the private header; behind a proxy that appends, the real
    // hop wins; with nothing trustworthy the header is gone entirely.
    const spoofed = new Headers({
      [CLIENT_IP_HEADER]: "198.51.100.77",
      "x-forwarded-for": "198.51.100.77, 203.0.113.9",
    });
    applyClientIpHeader(spoofed);
    expect(getIP(spoofed, betterAuthIpOptions)).toBe("203.0.113.9");

    const bare = new Headers({ [CLIENT_IP_HEADER]: "198.51.100.77" });
    applyClientIpHeader(bare);
    expect(bare.get(CLIENT_IP_HEADER)).toBeNull();
    expect(getIP(bare, betterAuthIpOptions)).not.toBe("198.51.100.77");
  });
});
