import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getIp } from "better-auth/api";
import type * as RouteModule from "@/app/api/auth/[...all]/route";
import { CLIENT_IP_HEADER, getClientIp } from "@/lib/client-ip";

/**
 * `/api/auth/[...all]` re-derives the trusted client-IP header in the route
 * handler itself (review #35, follow-up). `src/proxy.ts` stamps it first, but
 * the route must not depend on the matcher: Next injects `x-forwarded-for`
 * from the socket address only AFTER the proxy has run, so with nothing in
 * front of the app the proxy sees no chain (and removes the header) while
 * the handler does — re-deriving here keeps per-client buckets, and a value
 * a client injected can never reach Better Auth's limiter / session row.
 */
const handlerMock = vi.fn(async (_req: Request) => new Response(null, { status: 204 }));

vi.mock("@/lib/auth", () => ({ auth: { handler: (req: Request) => handlerMock(req) } }));

/** The exact Better Auth option block `src/lib/auth.ts` passes. */
const betterAuthIpOptions = {
  advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
} as BetterAuthOptions;

let GET: typeof RouteModule.GET;
let POST: typeof RouteModule.POST;

beforeEach(async () => {
  handlerMock.mockClear();
  ({ GET, POST } = await import("@/app/api/auth/[...all]/route"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function received(): Request {
  return handlerMock.mock.calls[0]![0];
}

describe("api/auth/[...all] — trusted client-IP header re-derived in the handler", () => {
  it("overwrites a client-injected x-drk-client-ip with the trusted hop and keeps the body", async () => {
    const body = JSON.stringify({ email: "a@example.com", password: "pw" });
    const res = await POST(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "ba.session=x",
          [CLIENT_IP_HEADER]: "6.6.6.6",
          "x-forwarded-for": "6.6.6.6, 203.0.113.9",
        },
        body,
      }),
    );
    expect(res.status).toBe(204);
    const req = received();
    expect(req.method).toBe("POST");
    expect(req.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(getIp(req.headers, betterAuthIpOptions)).toBe("203.0.113.9");
    // Everything Better Auth needs survives the re-wrap.
    expect(req.headers.get("cookie")).toBe("ba.session=x");
    expect(req.headers.get("content-type")).toBe("application/json");
    await expect(req.text()).resolves.toBe(body);
  });

  it("stamps the header from a single-hop chain even when the proxy did not run (direct exposure)", async () => {
    // What the handler sees with no edge in front: Next's own
    // `x-forwarded-for ??= socket.remoteAddress` and no `x-drk-client-ip`.
    await GET(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { "x-forwarded-for": "203.0.113.9" },
      }),
    );
    expect(received().headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("removes an injected header when nothing trustworthy is present (fail closed)", async () => {
    await GET(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { [CLIENT_IP_HEADER]: "6.6.6.6" },
      }),
    );
    const req = received();
    expect(req.headers.has(CLIENT_IP_HEADER)).toBe(false);
    expect(getIp(req.headers, betterAuthIpOptions)).not.toBe("6.6.6.6");
  });

  it("honors TRUSTED_PROXY_COUNT — the same hop the app's own limiter and audit rows use", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    const headers = { "x-forwarded-for": "spoof, 203.0.113.9, 10.0.0.2" };
    await POST(
      new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers }),
    );
    expect(received().headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(received().headers.get(CLIENT_IP_HEADER)).toBe(getClientIp(new Headers(headers)));
  });

  it("accepts the NextRequest Next hands route handlers and keeps url/method/body (Node ≥ 24 realm regression)", async () => {
    // Regression for the #397 outage: `new Request(nextRequest, init)` throws
    // "Cannot read private member #state" on Node ≥ 24 because Next's
    // NextRequest is built in another realm; the wrapper must rebuild the
    // request from its parts instead.
    const { NextRequest } = await import("next/server");
    const body = JSON.stringify({ email: "a@example.com", password: "pw" });
    const res = await POST(
      new NextRequest("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "ba.session=x",
          "x-forwarded-for": "203.0.113.9",
        },
        body,
      }),
    );
    expect(res.status).toBe(204);
    const req = received();
    expect(req.url).toBe("http://localhost:3000/api/auth/sign-in/email");
    expect(req.method).toBe("POST");
    expect(req.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(req.headers.get("cookie")).toBe("ba.session=x");
    await expect(req.text()).resolves.toBe(body);
  });

  it("forwards a body-less POST (sign-out) and a GET as body-less, not as an empty stream", async () => {
    const { NextRequest } = await import("next/server");
    await POST(
      new NextRequest("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.9" },
      }),
    );
    expect(received().method).toBe("POST");
    expect(received().body).toBeNull();
    handlerMock.mockClear();
    await GET(new NextRequest("http://localhost:3000/api/auth/get-session"));
    expect(received().method).toBe("GET");
    expect(received().body).toBeNull();
  });
});
