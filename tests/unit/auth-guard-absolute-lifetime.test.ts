import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review #200 — `getCurrentSession()` is the single chokepoint every browser
 * guard, server action and cookie-authenticated `/api/v1` caller reads the
 * session through, so the absolute lifetime is enforced there.
 *
 * Both settings are tested, and the DEFAULT case is the important one: with
 * `SESSION_ABSOLUTE_LIFETIME_HOURS` unset, a session of ANY age still resolves
 * — the rolling behaviour that shipped before this knob is untouched.
 */
const getSessionMock = vi.fn();
const deleteSessionMock = vi.fn();
const logServerError = vi.fn();
const ambient = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => ambient.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: { getSession: (...args: unknown[]) => getSessionMock(...args) },
    $context: Promise.resolve({
      internalAdapter: { deleteSession: (...args: unknown[]) => deleteSessionMock(...args) },
    }),
  },
}));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}));

const HOUR = 60 * 60 * 1000;
const originalLifetime = process.env.SESSION_ABSOLUTE_LIFETIME_HOURS;

function sessionAgedHours(hours: number) {
  return {
    user: { id: "ba-1" },
    session: { token: "sess-token", createdAt: new Date(Date.now() - hours * HOUR) },
  };
}

async function loadGuard(lifetimeHours: string | undefined) {
  if (lifetimeHours === undefined) delete process.env.SESSION_ABSOLUTE_LIFETIME_HOURS;
  else process.env.SESSION_ABSOLUTE_LIFETIME_HOURS = lifetimeHours;
  vi.resetModules();
  return import("@/lib/auth-guard");
}

beforeEach(() => {
  getSessionMock.mockReset();
  deleteSessionMock.mockReset();
  logServerError.mockReset();
  ambient.headers = new Headers();
});
afterEach(() => {
  if (originalLifetime === undefined) delete process.env.SESSION_ABSOLUTE_LIFETIME_HOURS;
  else process.env.SESSION_ABSOLUTE_LIFETIME_HOURS = originalLifetime;
  vi.resetModules();
});

describe("getCurrentSession — absolute session lifetime (review #200)", () => {
  it("UNSET (the default): a very old rolling session still resolves and is never revoked", async () => {
    const mod = await loadGuard(undefined);
    const ancient = sessionAgedHours(10_000);
    getSessionMock.mockResolvedValue(ancient);
    await expect(mod.getCurrentSession()).resolves.toBe(ancient);
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it("SET: a session younger than the cap resolves normally", async () => {
    const mod = await loadGuard("168");
    const young = sessionAgedHours(167);
    getSessionMock.mockResolvedValue(young);
    await expect(mod.getCurrentSession()).resolves.toBe(young);
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it("SET: a session older than the cap is reported absent and revoked", async () => {
    const mod = await loadGuard("168");
    getSessionMock.mockResolvedValue(sessionAgedHours(169));
    await expect(mod.getCurrentSession()).resolves.toBeNull();
    expect(deleteSessionMock).toHaveBeenCalledWith("sess-token");
  });

  it("SET: the cap is measured from CREATION, so activity cannot roll past it", async () => {
    const mod = await loadGuard("24");
    // A session refreshed seconds ago but created 25 hours ago is still over.
    getSessionMock.mockResolvedValue({
      user: { id: "ba-1" },
      session: {
        token: "sess-token",
        createdAt: new Date(Date.now() - 25 * HOUR),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 8 * HOUR),
      },
    });
    await expect(mod.getCurrentSession()).resolves.toBeNull();
  });

  it("SET: still reports the session absent when revocation fails", async () => {
    const mod = await loadGuard("1");
    getSessionMock.mockResolvedValue(sessionAgedHours(5));
    deleteSessionMock.mockRejectedValue(new Error("db down"));
    await expect(mod.getCurrentSession()).resolves.toBeNull();
    expect(logServerError).toHaveBeenCalledWith(
      "absolute-lifetime session revocation failed",
      expect.objectContaining({ betterAuthUserId: "ba-1" }),
    );
  });

  it("passes an absent session straight through without consulting the clock", async () => {
    const mod = await loadGuard("1");
    getSessionMock.mockResolvedValue(null);
    await expect(mod.getCurrentSession()).resolves.toBeNull();
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });
});

/**
 * F-08 — an IMPERSONATION session is capped at one hour from creation on the
 * same path, independent of `SESSION_ABSOLUTE_LIFETIME_HOURS`. Better Auth's
 * own one-hour `expiresAt` rolls forward 8 h at a time once the holder drops
 * the `dont_remember` cookie, so these rows can look fresh to the vendor.
 */
describe("getCurrentSession — impersonation cap (F-08)", () => {
  const MINUTE = 60 * 1000;

  function borrowedSessionAgedMinutes(minutes: number, extra: Record<string, unknown> = {}) {
    return {
      user: { id: "ba-target" },
      session: {
        token: "borrowed-token",
        impersonatedBy: "ba-admin",
        createdAt: new Date(Date.now() - minutes * MINUTE),
        // Rolled forward by a refresh the plugin was never meant to allow.
        expiresAt: new Date(Date.now() + 8 * HOUR),
        ...extra,
      },
    };
  }

  it("keeps a borrowed session inside the hour", async () => {
    const mod = await loadGuard(undefined);
    const young = borrowedSessionAgedMinutes(59);
    getSessionMock.mockResolvedValue(young);
    await expect(mod.getCurrentSession()).resolves.toBe(young);
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it("reports a borrowed session past the hour absent and revokes it — with the operator cap UNSET", async () => {
    const mod = await loadGuard(undefined);
    getSessionMock.mockResolvedValue(borrowedSessionAgedMinutes(61));
    await expect(mod.getCurrentSession()).resolves.toBeNull();
    expect(deleteSessionMock).toHaveBeenCalledWith("borrowed-token");
  });

  it("applies whichever cap is tighter: a generous operator cap does not extend a borrowed session", async () => {
    const mod = await loadGuard("168");
    getSessionMock.mockResolvedValue(borrowedSessionAgedMinutes(90));
    await expect(mod.getCurrentSession()).resolves.toBeNull();
  });

  it("fails closed on a borrowed session whose creation time is unreadable", async () => {
    const mod = await loadGuard(undefined);
    getSessionMock.mockResolvedValue(borrowedSessionAgedMinutes(1, { createdAt: undefined }));
    await expect(mod.getCurrentSession()).resolves.toBeNull();
  });

  it("does not touch an ORDINARY session of the same age", async () => {
    const mod = await loadGuard(undefined);
    const own = sessionAgedHours(3);
    getSessionMock.mockResolvedValue(own);
    await expect(mod.getCurrentSession()).resolves.toBe(own);
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });
});
