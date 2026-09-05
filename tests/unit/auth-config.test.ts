import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";

/**
 * Pins the security-relevant Better Auth configuration (AUTH-2). We mock
 * `betterAuth` to capture the options object the app constructs, so a
 * regression that drops `revokeSessionsOnPasswordReset` fails here rather
 * than silently leaving attacker sessions alive after a password reset.
 */
const betterAuthMock = vi.fn((_options: unknown) => ({ api: {}, $context: Promise.resolve({}) }));

vi.mock("better-auth", () => ({
  betterAuth: (opts: unknown) => betterAuthMock(opts),
}));
vi.mock("better-auth/plugins", () => ({ admin: () => ({ id: "admin" }) }));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));
vi.mock("@/lib/auth-sso-session", () => ({ ssoSession: () => ({ id: "sso-session" }) }));

interface CapturedOptions {
  emailAndPassword: { enabled?: boolean; revokeSessionsOnPasswordReset?: boolean };
  advanced?: {
    ipAddress?: { ipAddressHeaders?: string[]; disableIpTracking?: boolean };
    crossSubDomainCookies?: { enabled?: boolean; domain?: string };
  };
}

beforeEach(() => {
  betterAuthMock.mockClear();
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function capture(): Promise<CapturedOptions> {
  await import("@/lib/auth");
  expect(betterAuthMock).toHaveBeenCalledTimes(1);
  return betterAuthMock.mock.calls[0]?.[0] as CapturedOptions;
}

describe("Better Auth emailAndPassword config", () => {
  it("revokes all sessions on a password reset (AUTH-2)", async () => {
    await import("@/lib/auth");
    expect(betterAuthMock).toHaveBeenCalledTimes(1);
    const opts = betterAuthMock.mock.calls[0]?.[0] as CapturedOptions;
    expect(opts.emailAndPassword.enabled).toBe(true);
    expect(opts.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
  });
});

/**
 * Review #35: Better Auth's limiter + `session.ipAddress` must read ONLY the
 * header the proxy derives with the app's TRUSTED_PROXY_COUNT model — never
 * the raw `x-forwarded-for` (single-value-only trust: multi-hop chains
 * collapsed into one shared bucket; a bare client value was trusted).
 */
describe("Better Auth client-IP config (review #35)", () => {
  it("reads exactly the proxy-stamped header and keeps IP tracking on", async () => {
    const opts = await capture();
    expect(opts.advanced?.ipAddress?.ipAddressHeaders).toEqual([CLIENT_IP_HEADER]);
    expect(opts.advanced?.ipAddress?.ipAddressHeaders).not.toContain("x-forwarded-for");
    expect(opts.advanced?.ipAddress?.disableIpTracking).toBeFalsy();
  });

  it("keeps the ipAddress block when COOKIE_DOMAIN adds crossSubDomainCookies", async () => {
    vi.stubEnv("COOKIE_DOMAIN", ".example.test");
    const opts = await capture();
    expect(opts.advanced?.ipAddress?.ipAddressHeaders).toEqual([CLIENT_IP_HEADER]);
    expect(opts.advanced?.crossSubDomainCookies).toEqual({
      enabled: true,
      domain: ".example.test",
    });
  });
});
