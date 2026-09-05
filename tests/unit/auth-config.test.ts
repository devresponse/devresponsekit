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
  trustedOrigins?: string[];
  rateLimit?: { enabled?: boolean };
  emailAndPassword: {
    enabled?: boolean;
    requireEmailVerification?: boolean;
    revokeSessionsOnPasswordReset?: boolean;
  };
  emailVerification?: { sendOnSignUp?: boolean; autoSignInAfterVerification?: boolean };
  account?: {
    accountLinking?: {
      enabled?: boolean;
      trustedProviders?: string[];
      allowDifferentEmails?: boolean;
    };
  };
  session?: { expiresIn?: number; updateAge?: number };
  user?: { additionalFields?: Record<string, Record<string, unknown>> };
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
 * Review #121: pin the whole security subtree EXPLICITLY (no blob snapshot —
 * a snapshot would ratify whatever the file happens to contain). Each value
 * here is a decision a regression could silently undo: sign-in gated on a
 * verified mailbox, an 8 h rolling session, the CSRF allow-list shared with
 * the origin guard, the limiter on unless the test-only escape hatch is set,
 * host-only cookies unless a parent domain is configured, and the nOAuth
 * account-takeover defence (`trustedProviders: []`, review #305).
 */
describe("Better Auth security subtree (review #121)", () => {
  it("gates email/password sign-in on a verified address and never auto-signs-in after verification", async () => {
    const opts = await capture();
    expect(opts.emailAndPassword.enabled).toBe(true);
    expect(opts.emailAndPassword.requireEmailVerification).toBe(true);
    expect(opts.emailVerification?.sendOnSignUp).toBe(true);
    expect(opts.emailVerification?.autoSignInAfterVerification).toBe(false);
  });

  it("uses an 8-hour rolling session refreshed every 15 minutes", async () => {
    const opts = await capture();
    expect(opts.session?.expiresIn).toBe(8 * 60 * 60);
    expect(opts.session?.updateAge).toBe(15 * 60);
  });

  it("derives trustedOrigins from the SAME env allow-list the admin origin guard uses (deduplicated, normalized)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test/some/path");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.example.test");
    vi.stubEnv("ADMIN_TRUSTED_ORIGINS", " https://extra.example.test , https://app.example.test ");
    const opts = await capture();
    expect(opts.trustedOrigins).toEqual(["https://app.example.test", "https://extra.example.test"]);
  });

  it("links social accounts only on a VERIFIED matching email — no trusted providers, no differing emails (review #305)", async () => {
    const opts = await capture();
    expect(opts.account?.accountLinking).toEqual({
      enabled: true,
      trustedProviders: [],
      allowDifferentEmails: false,
    });
  });

  it("leaves Better Auth's limiter ON unless AUTH_RATE_LIMIT_DISABLED is set", async () => {
    vi.stubEnv("AUTH_RATE_LIMIT_DISABLED", "");
    const on = await capture();
    // Absent, not `{ enabled: true }`: the plugin's production default applies.
    expect(on).not.toHaveProperty("rateLimit");

    vi.resetModules();
    betterAuthMock.mockClear();
    vi.stubEnv("AUTH_RATE_LIMIT_DISABLED", "1");
    const off = await capture();
    expect(off.rateLimit).toEqual({ enabled: false });
  });

  it("issues host-only cookies unless COOKIE_DOMAIN opts into a parent domain", async () => {
    vi.stubEnv("COOKIE_DOMAIN", "");
    const hostOnly = await capture();
    expect(hostOnly.advanced).not.toHaveProperty("crossSubDomainCookies");

    vi.resetModules();
    betterAuthMock.mockClear();
    vi.stubEnv("COOKIE_DOMAIN", ".example.test");
    const shared = await capture();
    expect(shared.advanced?.crossSubDomainCookies).toEqual({
      enabled: true,
      domain: ".example.test",
    });
  });

  it("reads the client IP from exactly the proxy-stamped `x-drk-client-ip` header (review #397)", async () => {
    const opts = await capture();
    expect(opts.advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-drk-client-ip"]);
    expect(CLIENT_IP_HEADER).toBe("x-drk-client-ip");
  });
});

/**
 * Review #2: the policy-waived verification marker must be a Better Auth
 * user field that clients cannot set (`input: false`) and that every other
 * creation path leaves at `false` — otherwise the marker is worthless as a
 * distinction between "waived" and "proven".
 */
describe("Better Auth user.additionalFields (review #2)", () => {
  it("declares emailVerificationWaived as a server-only boolean defaulting to false", async () => {
    const opts = await capture();
    expect(opts.user?.additionalFields?.emailVerificationWaived).toEqual({
      type: "boolean",
      required: false,
      defaultValue: false,
      input: false,
    });
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
