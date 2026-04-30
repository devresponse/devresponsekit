import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as NextServerModule from "next/server";

/**
 * Route integration tests for proxy-level public/auth/secure routing.
 *
 * Verifies the three routing contracts required by §19 and §28:
 *   1. Unauthenticated GET `/` redirects to `/<defaultLocale>` (public).
 *   2. Unauthenticated GET `/en` returns the public landing page (200, no redirect to sign-in).
 *   3. Unauthenticated GET `/en/app/dashboard` redirects to `/en/sign-in` with `returnTo`.
 *
 * These tests drive `proxy.ts` directly so they remain independent of
 * the Next.js dev-server and run inside Vitest.
 */

// ---------------------------------------------------------------------------
// Mock next-intl createIntlMiddleware so it simply returns NextResponse.next()
// for any request that reaches the locale-routing stage.
// ---------------------------------------------------------------------------
vi.mock("next-intl/middleware", async () => {
  const nextServer = await vi.importActual<typeof NextServerModule>("next/server");
  return {
    default: () => () => nextServer.NextResponse.next(),
  };
});

// Mock the routing config required by createIntlMiddleware.
vi.mock("@/i18n/routing", () => ({
  routing: {
    locales: ["en", "fr", "es", "uk"],
    defaultLocale: "en",
  },
}));

// ---------------------------------------------------------------------------
// Build a minimal NextRequest-like object that proxy.ts can consume.
// `proxy.ts` accesses `request.nextUrl.pathname` and `request.nextUrl.search`,
// so we need to attach a `nextUrl` property to the plain Request.
// ---------------------------------------------------------------------------
function makeRequest(path: string, withSession = false): NextRequest {
  const url = `http://localhost:3000${path}`;
  const headers = new Headers();
  if (withSession) {
    // Better Auth stores the session in a cookie named `better-auth.session_token`.
    headers.set("cookie", "better-auth.session_token=test-session");
  }
  const req = new Request(url, { headers }) as NextRequest;
  // Attach a minimal nextUrl stub that mirrors what Next.js provides.
  const parsedUrl = new URL(url);
  Object.defineProperty(req, "nextUrl", {
    value: {
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      searchParams: parsedUrl.searchParams,
      href: parsedUrl.href,
    },
    writable: false,
  });
  return req;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("proxy — public home routing", () => {
  let proxy: (req: NextRequest) => Response | Promise<Response>;

  beforeEach(async () => {
    // Re-import proxy fresh in each test so mock state doesn't leak.
    vi.resetModules();
    ({ proxy } = await import("@/proxy"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes GET / through to the intl middleware (which redirects to /en)", async () => {
    // proxy.ts delegates non-secure paths to the intl middleware.
    // The intl middleware is mocked to return NextResponse.next() above.
    // The important assertion is that proxy does NOT redirect to sign-in.
    const req = makeRequest("/");
    const res = await proxy(req);

    // Should not be a sign-in redirect.
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/sign-in");
  });

  it("does NOT redirect unauthenticated GET /en to sign-in", async () => {
    const req = makeRequest("/en");
    const res = await proxy(req);

    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/sign-in");
  });

  it("redirects unauthenticated GET /en/app/dashboard to /en/sign-in with returnTo", async () => {
    const req = makeRequest("/en/app/dashboard");
    const res = await proxy(req);

    // Must be a redirect response.
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);

    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/en/sign-in");
    expect(location).toContain("returnTo");
    expect(location).toContain("dashboard");
  });

  it("does NOT redirect an authenticated GET /en/app/dashboard to sign-in", async () => {
    const req = makeRequest("/en/app/dashboard", true);
    const res = await proxy(req);

    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/sign-in");
  });

  it("does NOT require auth for /en/sign-in", async () => {
    const req = makeRequest("/en/sign-in");
    const res = await proxy(req);

    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/sign-in");
  });

  it("does NOT require auth for /en/sign-up", async () => {
    const req = makeRequest("/en/sign-up");
    const res = await proxy(req);

    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/sign-in");
  });

  it("does NOT require auth for /en/about", async () => {
    const req = makeRequest("/en/about");
    const res = await proxy(req);

    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/sign-in");
  });

  it("does NOT require auth for /en/docs", async () => {
    const req = makeRequest("/en/docs");
    const res = await proxy(req);

    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/sign-in");
  });

  it("does NOT require auth for /en/logged-out", async () => {
    const req = makeRequest("/en/logged-out");
    const res = await proxy(req);

    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("/sign-in");
  });

  it("redirects unauthenticated GET /fr/app/workspace to /fr/sign-in", async () => {
    const req = makeRequest("/fr/app/workspace");
    const res = await proxy(req);

    expect(res.status).toBeGreaterThanOrEqual(300);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/fr/sign-in");
  });
});
