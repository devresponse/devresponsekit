import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ProxyModule from "@/proxy";
import type * as RouteRegionsModule from "@/config/route-regions";
import { REQUEST_PATH_HEADER } from "@/lib/request-id";

/**
 * `x-drk-pathname` provenance in `proxy.ts` (the follow-up finding to review
 * #74).
 *
 * #74 added the header so an RSC permission denial can name the page that was
 * probed, and both `proxy.ts` and `lib/request-id.ts` claimed the value
 * "cannot be spoofed by a browser: the proxy overwrites whatever arrived".
 * It did not:
 *
 *   1. it was `set` on the localized-page branch ONLY, so the `/api/*` early
 *      return forwarded a client-supplied copy untouched; and
 *   2. the page matcher excludes `.*\..*` — ANY path containing a dot — so
 *      `GET /en/app/administrator/users/a.b` skipped the proxy entirely and
 *      `headers()` handed the guard the RAW client headers, which
 *      `auditRscDenial` then wrote verbatim into `app_audit_events`.
 *
 * These tests pin the fix: the inbound copy is deleted before any branch
 * returns, and the matcher now covers the localized secure tree so a dotted
 * segment inside an admin URL cannot dodge the proxy.
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
vi.mock("@/config/route-regions", async () => {
  const actual = await vi.importActual<typeof RouteRegionsModule>("@/config/route-regions");
  return { ...actual, isLocalizedSecurePath: (p: string) => guard.secure && p.startsWith("/") };
});

let proxy: typeof ProxyModule.proxy;
let config: typeof ProxyModule.config;

const FORGED = "/en/app/dashboard' OR 1=1 -- an attacker-chosen string";

function req(pathname: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000${pathname}`), {
    method: pathname.startsWith("/api/") ? "POST" : "GET",
    headers,
  });
}

/** Reads a forwarded request header off the `NextResponse.next()` envelope. */
function forwardedHeader(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

beforeEach(async () => {
  intlState.captured = null;
  guard.session = "ba.session=x";
  guard.secure = false;
  ({ proxy, config } = await import("@/proxy"));
});
afterEach(() => vi.resetModules());

describe("proxy — x-drk-pathname is the proxy's own value", () => {
  it("stamps the resolved pathname on a localized page render", () => {
    proxy(req("/en/app/administrator/audit"));
    expect(intlState.captured?.headers.get(REQUEST_PATH_HEADER)).toBe(
      "/en/app/administrator/audit",
    );
  });

  it("OVERWRITES a client-supplied value with the real path", () => {
    proxy(req("/en/app/administrator/audit", { [REQUEST_PATH_HEADER]: FORGED }));
    expect(intlState.captured?.headers.get(REQUEST_PATH_HEADER)).toBe(
      "/en/app/administrator/audit",
    );
  });

  it("DELETES a client-supplied value on the /api/* branch, which stamps nothing", () => {
    // The early return forwards headers without ever setting the pathname, so
    // deleting on the copy is the only thing standing between a forged header
    // and anything downstream that reads it.
    const res = proxy(req("/api/auth/sign-in/email", { [REQUEST_PATH_HEADER]: FORGED }));
    expect(forwardedHeader(res, REQUEST_PATH_HEADER)).toBeNull();
  });

  it("DELETES it on the unauthenticated-redirect branch too (no forwarded request at all)", () => {
    guard.secure = true;
    guard.session = null;
    const res = proxy(req("/en/app/administrator/audit", { [REQUEST_PATH_HEADER]: FORGED }));
    expect(res.status).toBe(307);
    expect(forwardedHeader(res, REQUEST_PATH_HEADER)).toBeNull();
  });
});

describe("proxy — the matcher covers the localized secure tree", () => {
  const DOTTED = "/en/app/administrator/users/a.b";

  it("matches /:locale/app/:path* so a dotted admin URL cannot skip the proxy", () => {
    expect(config.matcher).toContain("/:locale/app/:path*");
  });

  it("the general page matcher alone would NOT have matched a dotted path", () => {
    // Pins WHY the extra entry exists: `.*\..*` in the general pattern
    // excludes every path containing a dot, and Next still routes such a
    // path to the RSC.
    const general = config.matcher.find((m) => m.includes("(?!api|"));
    expect(general).toBeDefined();
    expect(new RegExp(`^${general as string}$`).test(DOTTED)).toBe(false);
    expect(new RegExp(`^${general as string}$`).test("/en/app/administrator/users")).toBe(true);
  });

  it("stamps the real path for a dotted admin URL, forged header and all", () => {
    proxy(req(DOTTED, { [REQUEST_PATH_HEADER]: FORGED }));
    expect(intlState.captured?.headers.get(REQUEST_PATH_HEADER)).toBe(DOTTED);
  });
});
