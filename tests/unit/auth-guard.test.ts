import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthGuardModule from "@/lib/auth-guard";
import type * as AuthStatusModule from "@/lib/auth-status";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";

/**
 * Unit tests for `auth-guard.ts` (`getCurrentSession` and
 * `requireSecureSession`).
 *
 * `auth.api.getSession`, `next/headers`, and `next/navigation.redirect`
 * are mocked so we can verify the guard's redirect targets without
 * standing up Next.js. `requireSecureSession` calls `redirect()` which
 * throws by Next.js convention; we assert the correct destination by
 * inspecting the throw payload.
 */

const getSessionMock = vi.fn();
const accessGetter = vi.fn();
const redirectMock = vi.fn((url: string) => {
  throw new Error(`__REDIRECT__:${url}`);
});

const ambient = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => ambient.headers,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionMock(...args) } },
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});

let mod: typeof AuthGuardModule;

beforeEach(async () => {
  getSessionMock.mockReset();
  accessGetter.mockReset();
  redirectMock.mockClear();
  ambient.headers = new Headers();
  mod = await import("@/lib/auth-guard");
});
afterEach(() => vi.resetModules());

describe("getCurrentSession", () => {
  it("forwards the request headers to Better Auth", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "ba-1" } });
    ambient.headers = new Headers({ cookie: "ba.session=x" });
    const result = await mod.getCurrentSession();
    expect(getSessionMock).toHaveBeenCalledWith({ headers: expect.any(Headers) });
    expect((getSessionMock.mock.calls[0]![0] as { headers: Headers }).headers.get("cookie")).toBe(
      "ba.session=x",
    );
    expect(result).toEqual({ user: { id: "ba-1" } });
  });

  it("hands Better Auth a copy stamped with the trusted client IP, never an injected one (review #35)", async () => {
    getSessionMock.mockResolvedValue(null);
    ambient.headers = new Headers({
      [CLIENT_IP_HEADER]: "6.6.6.6",
      "x-forwarded-for": "6.6.6.6, 203.0.113.9",
    });
    await mod.getCurrentSession();
    const passed = (getSessionMock.mock.calls[0]![0] as { headers: Headers }).headers;
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    // The ambient (read-only in Next) store is not mutated.
    expect(ambient.headers.get(CLIENT_IP_HEADER)).toBe("6.6.6.6");
  });
});

/**
 * Review #122: `getImpersonatorId` is the authority for "is this an
 * impersonation session" (STOP-impersonation, the active-org switch, the SSO
 * launch refusal) and had no unit coverage — every consumer suite re-mocked
 * it. Pin the real function against the session shape `getCurrentSession`
 * returns.
 */
describe("getImpersonatorId", () => {
  type Session = Awaited<ReturnType<typeof mod.getCurrentSession>>;
  const asSession = (v: unknown) => v as Session;

  it("returns the impersonating admin's id from the plugin's camelCase field", () => {
    expect(
      mod.getImpersonatorId(
        asSession({ user: { id: "target" }, session: { id: "s", impersonatedBy: "admin-9" } }),
      ),
    ).toBe("admin-9");
  });

  it("accepts the snake_case column spelling (plugin version drift)", () => {
    expect(
      mod.getImpersonatorId(
        asSession({ user: { id: "target" }, session: { id: "s", impersonated_by: "admin-9" } }),
      ),
    ).toBe("admin-9");
  });

  it("is null for a plain session and for no session", () => {
    expect(
      mod.getImpersonatorId(
        asSession({ user: { id: "u" }, session: { id: "s", impersonatedBy: null } }),
      ),
    ).toBeNull();
    expect(mod.getImpersonatorId(asSession({ user: { id: "u" } }))).toBeNull();
    expect(mod.getImpersonatorId(null)).toBeNull();
  });
});

describe("requireSecureSession", () => {
  it("redirects to localized sign-in with a sanitized returnTo when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(mod.requireSecureSession("en", "/en/app/workspace")).rejects.toThrow(
      /__REDIRECT__:\/en\/sign-in\?returnTo=%2Fen%2Fapp%2Fworkspace/,
    );
  });

  it("falls back to the dashboard returnTo when the supplied one is unsafe", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(mod.requireSecureSession("en", "https://evil.example.com")).rejects.toThrow(
      /__REDIRECT__:\/en\/sign-in\?returnTo=%2Fen%2Fapp%2Fdashboard/,
    );
  });

  it("redirects pending users to /pending-approval", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u",
      primaryEmail: "u@x.com",
      status: "pending_approval",
      organizationId: null,
      membershipStatus: null,
      preferredLocale: "en",
      permissions: [],
    });
    await expect(mod.requireSecureSession("en")).rejects.toThrow(
      /__REDIRECT__:\/en\/pending-approval/,
    );
  });

  it("redirects blocked users to /blocked with the reason", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u",
      primaryEmail: "u@x.com",
      status: "blocked",
      organizationId: "o",
      membershipStatus: "blocked",
      preferredLocale: "en",
      permissions: [],
    });
    await expect(mod.requireSecureSession("en")).rejects.toThrow(
      /__REDIRECT__:\/en\/blocked\?reason=blocked/,
    );
  });

  it("returns the session + access context when the user is fully active", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["shell.view"],
    });
    const result = await mod.requireSecureSession("en");
    expect(result.session.user.id).toBe("ba-1");
    expect(result.access.permissions).toContain("shell.view");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
