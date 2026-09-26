import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as NextTesting from "next/experimental/testing/server";
import type * as ProxyModule from "@/proxy";
import type * as RouteRegionsModule from "@/config/route-regions";
import { REQUEST_PATH_HEADER, REQUEST_TARGET_HEADER } from "@/lib/request-id";

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

/**
 * F-106: the dot-excluding page entry skipped `/en/sign-in/a.b`, and
 * `sign-in/[org]` renders the full password form for any segment, so that URL
 * served the credential form with no CSP and no proxy headers. The matcher is
 * judged by Next's own matcher (`unstable_doesMiddlewareMatch`; the docs call
 * it `unstable_doesProxyMatch`, a name this Next release does not export yet),
 * not by a hand-rolled regex. It loads Next's request-storage singletons,
 * which need the host's `AsyncLocalStorage`.
 */
describe("proxy — the matcher covers every localized page that takes a dynamic segment", () => {
  let doesMatch: typeof NextTesting.unstable_doesMiddlewareMatch;

  beforeAll(async () => {
    (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
    ({ unstable_doesMiddlewareMatch: doesMatch } =
      await import("next/experimental/testing/server"));
  });

  const LOCALIZED_DIR = fileURLToPath(new URL("../../src/app/[locale]", import.meta.url));

  function pages(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...pages(full));
      else if (entry === "page.tsx") out.push(full);
    }
    return out;
  }

  /**
   * `(auth)/sign-in/[org]/page.tsx` → `/en/sign-in/a.b`: route groups dropped,
   * every dynamic segment filled with a DOTTED value, the shape the general
   * entry excludes. `null` for a page with no dynamic segment.
   */
  function dottedUrl(page: string): string | null {
    const segments = page
      .slice(LOCALIZED_DIR.length)
      .replace(/\\/g, "/")
      .split("/")
      .filter((s) => s !== "" && s !== "page.tsx" && !/^\(.*\)$/.test(s));
    if (!segments.some((s) => s.startsWith("["))) return null;
    return `/en/${segments.map((s) => (s.startsWith("[") ? "a.b" : s)).join("/")}`;
  }

  it("matches /:locale/sign-in/:path*", () => {
    expect(config.matcher).toContain("/:locale/sign-in/:path*");
    expect(doesMatch({ config, url: "/en/sign-in/a.b" })).toBe(true);
    expect(doesMatch({ config, url: "/fr/sign-in/acme.corp?returnTo=%2Ffr%2Fapp" })).toBe(true);
  });

  it("runs the proxy on a dotted URL for EVERY dynamic localized page", () => {
    const urls = pages(LOCALIZED_DIR)
      .map(dottedUrl)
      .filter((u): u is string => u !== null);
    // sign-in/[org] plus the secure tree's detail and docs pages today.
    expect(urls).toContain("/en/sign-in/a.b");
    expect(urls.length).toBeGreaterThanOrEqual(9);
    for (const url of urls) {
      expect(doesMatch({ config, url }), url).toBe(true);
    }
  });

  it("still skips static assets and the API routes it never needed", () => {
    for (const url of [
      "/brand/logo.png",
      "/_next/static/chunks/app.js",
      "/favicon.ico",
      "/api/administrator/users",
    ]) {
      expect(doesMatch({ config, url }), url).toBe(false);
    }
  });

  it("sets an enforcing CSP on the dotted sign-in URL it now sees", () => {
    const res = proxy(req("/en/sign-in/a.b"));
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(intlState.captured?.headers.get(REQUEST_PATH_HEADER)).toBe("/en/sign-in/a.b");
  });
});

/**
 * F-70: `requireSecureSession` bounces a present-but-dead session cookie to
 * sign-in, and needs the page that was requested — query included, exactly as
 * the proxy's own no-cookie redirect keeps it — to send the user back there.
 * `x-drk-pathname` is path-only (it lands in audit rows), so the request
 * target rides a header of its own, with the same provenance rules.
 */
describe("proxy — x-drk-request-target (F-70)", () => {
  const DEEP = "/en/app/administrator/users/u-42?tab=roles&page=2";

  it("stamps path AND query on a secure page", () => {
    guard.secure = true;
    proxy(req(DEEP));
    expect(intlState.captured?.headers.get(REQUEST_TARGET_HEADER)).toBe(DEEP);
    // The audit header stays path-only.
    expect(intlState.captured?.headers.get(REQUEST_PATH_HEADER)).toBe(
      "/en/app/administrator/users/u-42",
    );
  });

  it("OVERWRITES a client-supplied value with the real target", () => {
    guard.secure = true;
    proxy(req(DEEP, { [REQUEST_TARGET_HEADER]: "https://evil.example/x" }));
    expect(intlState.captured?.headers.get(REQUEST_TARGET_HEADER)).toBe(DEEP);
  });

  it("stamps nothing outside the secure tree, where queries carry invite and reset tokens", () => {
    proxy(req("/en/invite?token=example-invite-token", { [REQUEST_TARGET_HEADER]: FORGED }));
    expect(intlState.captured?.headers.get(REQUEST_TARGET_HEADER)).toBeNull();
  });

  it("DELETES a client-supplied value on the /api/* branch", () => {
    const res = proxy(req("/api/auth/sign-in/email", { [REQUEST_TARGET_HEADER]: FORGED }));
    expect(forwardedHeader(res, REQUEST_TARGET_HEADER)).toBeNull();
  });

  it("keeps the no-cookie redirect's returnTo in the same shape", () => {
    guard.secure = true;
    guard.session = null;
    const res = proxy(req(DEEP, { [REQUEST_TARGET_HEADER]: FORGED }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("returnTo")).toBe(DEEP);
    expect(forwardedHeader(res, REQUEST_TARGET_HEADER)).toBeNull();
  });
});
