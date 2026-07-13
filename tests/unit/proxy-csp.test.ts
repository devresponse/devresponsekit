import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ProxyModule from "@/proxy";

/**
 * Per-request CSP nonce in `proxy.ts` (enforcing-CSP cutover, review #34).
 *
 * Pins the security-critical contract: an ENFORCING `Content-Security-Policy`
 * (never the old `-Report-Only`) is set on every response; in production
 * `script-src` carries a per-request `'nonce-…'` + `'strict-dynamic'` and
 * drops `'unsafe-inline'`/`'unsafe-eval'`; the same nonce is threaded into the
 * request (`x-nonce` + the CSP) so Next + the server theme script can stamp it
 * onto inline scripts; and the report sink wiring survives the switch.
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

function req(pathname: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000${pathname}`));
}

/** The `nonce-…` value carried in the policy's script-src, if any. */
function scriptNonce(csp: string): string | null {
  return /script-src[^;]*'nonce-([^']+)'/.exec(csp)?.[1] ?? null;
}
function scriptSrc(csp: string): string {
  return csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
}

beforeEach(async () => {
  intlState.captured = null;
  guard.session = "ba.session=x";
  guard.secure = false;
  ({ proxy } = await import("@/proxy"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("proxy — enforcing CSP (production)", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

  it("sets an ENFORCING policy (not Report-Only) with a script nonce + strict-dynamic", () => {
    const res = proxy(req("/en"));
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();

    const ss = scriptSrc(csp!);
    expect(ss).toContain("'strict-dynamic'");
    expect(scriptNonce(csp!)).toBeTruthy();
    // The whole point: no inline/eval escape hatch in script-src.
    expect(ss).not.toContain("'unsafe-inline'");
    expect(ss).not.toContain("'unsafe-eval'");
  });

  it("threads the SAME nonce into the rendered request (x-nonce + CSP header)", () => {
    const res = proxy(req("/en"));
    const responseNonce = scriptNonce(res.headers.get("Content-Security-Policy")!);
    expect(intlState.captured).not.toBeNull();
    expect(intlState.captured!.headers.get("x-nonce")).toBe(responseNonce);
    expect(intlState.captured!.headers.get("Content-Security-Policy")).toContain(
      `'nonce-${responseNonce}'`,
    );
  });

  it("keeps the report sink + clickjacking + style directives through the switch", () => {
    const csp = proxy(req("/en")).headers.get("Content-Security-Policy")!;
    expect(csp).toContain("report-uri /api/security/csp-report");
    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("frame-ancestors 'none'");
    // Styles intentionally keep 'unsafe-inline' (nonces can't cover style attrs).
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // Production upgrades http subresources/form posts; dev must not (see below).
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("mints a fresh nonce per request", () => {
    const a = scriptNonce(proxy(req("/en")).headers.get("Content-Security-Policy")!);
    const b = scriptNonce(proxy(req("/en")).headers.get("Content-Security-Policy")!);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("still applies an enforcing CSP to an unauthenticated secure-path redirect", () => {
    guard.secure = true;
    guard.session = null;
    const res = proxy(req("/en/app/administrator"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/sign-in");
    expect(res.headers.get("Content-Security-Policy")).toContain("'strict-dynamic'");
  });
});

describe("proxy — development CSP", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "development"));

  it("keeps 'unsafe-inline'/'unsafe-eval' for HMR and uses no nonce", () => {
    const csp = proxy(req("/en")).headers.get("Content-Security-Policy")!;
    const ss = scriptSrc(csp);
    expect(ss).toContain("'unsafe-inline'");
    expect(ss).toContain("'unsafe-eval'");
    expect(scriptNonce(csp)).toBeNull();
  });

  it("omits upgrade-insecure-requests (it would break http dev hosts that aren't localhost)", () => {
    // A non-localhost dev host (e.g. app1.devresponse.local) is not a
    // "trustworthy origin", so the directive would silently upgrade every
    // subresource and form POST to https:// against the plain-http dev server.
    const csp = proxy(req("/en")).headers.get("Content-Security-Policy")!;
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});
