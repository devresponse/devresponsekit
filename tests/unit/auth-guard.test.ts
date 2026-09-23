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
 * Review #75 - an admin render funnels the secure layout, the administrator
 * layout and every page/nested guard through `getCurrentSession`, and
 * `session.cookieCache` is off, so each one was a real Better Auth session
 * read (4-5 per render). They all read the SAME incoming headers, so the
 * lookup is memoized per request, keyed on the request's `Headers` object.
 */
describe("getCurrentSession - per-request memoization (review #75)", () => {
  it("performs ONE Better Auth lookup for repeated calls in a request", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "ba-1" } });
    ambient.headers = new Headers({ cookie: "ba.session=x" });

    const results = [
      await mod.getCurrentSession(),
      await mod.getCurrentSession(),
      await mod.getCurrentSession(),
      await mod.getCurrentSession(),
      await mod.getCurrentSession(),
    ];

    expect(getSessionMock).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual({ user: { id: "ba-1" } });
  });

  it("shares ONE lookup between concurrent callers (guards run in parallel)", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "ba-1" } });
    ambient.headers = new Headers({ cookie: "ba.session=x" });

    await Promise.all([
      mod.getCurrentSession(),
      mod.getCurrentSession(),
      mod.getCurrentSession(),
      mod.getCurrentSession(),
    ]);

    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT reuse the answer across requests - a new Headers object re-reads", async () => {
    getSessionMock.mockResolvedValueOnce({ user: { id: "ba-1" } });
    ambient.headers = new Headers({ cookie: "ba.session=first" });
    expect(await mod.getCurrentSession()).toEqual({ user: { id: "ba-1" } });

    // Next hands every request its own headers object; a session that was
    // revoked (or an impersonation that was stopped) between requests MUST be
    // re-read, never served from the previous request's memo.
    getSessionMock.mockResolvedValueOnce(null);
    ambient.headers = new Headers({ cookie: "ba.session=revoked" });
    expect(await mod.getCurrentSession()).toBeNull();

    expect(getSessionMock).toHaveBeenCalledTimes(2);
  });

  it("does not pin a transient failure for the rest of the request", async () => {
    ambient.headers = new Headers({ cookie: "ba.session=x" });
    getSessionMock.mockRejectedValueOnce(new Error("boom"));
    await expect(mod.getCurrentSession()).rejects.toThrow("boom");

    getSessionMock.mockResolvedValueOnce({ user: { id: "ba-1" } });
    expect(await mod.getCurrentSession()).toEqual({ user: { id: "ba-1" } });
    expect(getSessionMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the impersonation marker visible to every caller in the request", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "target" },
      session: { id: "s", impersonatedBy: "admin-9" },
    });
    ambient.headers = new Headers({ cookie: "ba.session=x" });

    // The stop-impersonation authority derives from the memoized session.
    expect(mod.getImpersonatorId(await mod.getCurrentSession())).toBe("admin-9");
    expect(mod.getImpersonatorId(await mod.getCurrentSession())).toBe("admin-9");
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it("records an impersonated session against the ambient headers for audit attribution (F-07)", async () => {
    // The RSC admin gate audits its denials with `{ headers: await headers() }`,
    // so the ambient store is the carrier `auditEvent` must find the human on.
    const { readRequestImpersonation } = await import("@/lib/impersonation-attribution.server");
    getSessionMock.mockResolvedValue({
      user: { id: "target" },
      session: { id: "s", impersonatedBy: "admin-9" },
    });
    ambient.headers = new Headers({ cookie: "ba.session=x" });
    await mod.getCurrentSession();
    expect(readRequestImpersonation({ headers: ambient.headers })).toEqual({
      impersonatedBetterAuthUserId: "target",
      impersonatorBetterAuthUserId: "admin-9",
    });
  });

  it("records nothing for an ordinary session (F-07)", async () => {
    const { readRequestImpersonation } = await import("@/lib/impersonation-attribution.server");
    getSessionMock.mockResolvedValue({ user: { id: "ba-1" }, session: { id: "s" } });
    ambient.headers = new Headers({ cookie: "ba.session=x" });
    await mod.getCurrentSession();
    expect(readRequestImpersonation(ambient.headers)).toBeNull();
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
