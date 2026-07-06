import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ProxyModule from "@/proxy";

/**
 * `org_signup_hint` cookie lifecycle in `proxy.ts` — the bridge that carries an
 * organization-scoped sign-in's scope across the social OAuth round trip.
 * Set on a scoped sign-in/up page, cleared on a plain one, absent elsewhere.
 */
vi.mock("next-intl/middleware", async () => {
  const { NextResponse } = await import("next/server");
  return { default: () => () => NextResponse.next() };
});
vi.mock("better-auth/cookies", () => ({ getSessionCookie: () => "ba.session=x" }));
vi.mock("@/config/route-regions", () => ({ isLocalizedSecurePath: () => false }));

let proxy: typeof ProxyModule.proxy;

function req(pathname: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000${pathname}`), {
    headers: cookie ? { cookie } : undefined,
  });
}

const COOKIE = "org_signup_hint";

beforeEach(async () => {
  ({ proxy } = await import("@/proxy"));
});
afterEach(() => vi.resetModules());

describe("proxy — org_signup_hint cookie", () => {
  it("sets the hint from a scoped path (/sign-in/<org>)", () => {
    expect(proxy(req("/en/sign-in/acme")).cookies.get(COOKIE)?.value).toBe("acme");
  });

  it("sets the hint from the ?org= query on sign-in and sign-up", () => {
    expect(proxy(req("/en/sign-in?org=acme")).cookies.get(COOKIE)?.value).toBe("acme");
    expect(proxy(req("/fr/sign-up?org=beta")).cookies.get(COOKIE)?.value).toBe("beta");
  });

  it("marks the hint cookie httpOnly, lax, root path, short-lived", () => {
    const c = proxy(req("/en/sign-in/acme")).cookies.get(COOKIE);
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe("lax");
    expect(c?.path).toBe("/");
    expect(c?.maxAge).toBeGreaterThan(0);
    expect(c?.maxAge).toBeLessThanOrEqual(600);
  });

  it("clears a stale hint on a plain sign-in page", () => {
    const c = proxy(req("/en/sign-in", `${COOKIE}=stale`)).cookies.get(COOKIE);
    // A deletion surfaces as an empty-value Set-Cookie.
    expect(c?.value).toBe("");
  });

  it("does nothing on a plain sign-in page with no stale hint", () => {
    expect(proxy(req("/en/sign-in")).cookies.get(COOKIE)).toBeUndefined();
  });

  it("does not touch the hint on a non-auth page", () => {
    expect(proxy(req("/en/app/dashboard", `${COOKIE}=acme`)).cookies.get(COOKIE)).toBeUndefined();
  });
});
