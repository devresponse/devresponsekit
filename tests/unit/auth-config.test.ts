import { beforeEach, describe, expect, it, vi } from "vitest";

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
}

beforeEach(() => {
  betterAuthMock.mockClear();
  vi.resetModules();
});

describe("Better Auth emailAndPassword config", () => {
  it("revokes all sessions on a password reset (AUTH-2)", async () => {
    await import("@/lib/auth");
    expect(betterAuthMock).toHaveBeenCalledTimes(1);
    const opts = betterAuthMock.mock.calls[0]?.[0] as CapturedOptions;
    expect(opts.emailAndPassword.enabled).toBe(true);
    expect(opts.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
  });
});
