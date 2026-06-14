import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Mod from "@/lib/admin/auth-admin.server";

/**
 * Unit tests for the Better Auth admin wrappers (was 0% covered). Each
 * wrapper MUST forward the documented body shape to the matching
 * `auth.api.*` method, forward the actor's headers (explicit Headers,
 * `{ headers }`, or — when omitted — the ambient `next/headers()`), and
 * return the plugin's response untouched.
 */
const api = {
  createUser: vi.fn(),
  updateUser: vi.fn(),
  setRole: vi.fn(),
  setUserPassword: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  listUserSessions: vi.fn(),
  revokeUserSession: vi.fn(),
  revokeUserSessions: vi.fn(),
  impersonateUser: vi.fn(),
  stopImpersonating: vi.fn(),
  requestPasswordReset: vi.fn(),
};
const ambientHeaders = new Headers({ "x-ambient": "1" });

// Mocking @/lib/auth keeps the real Better Auth + pgPool chain out.
vi.mock("@/lib/auth", () => ({ auth: { api } }));
vi.mock("next/headers", () => ({ headers: async () => ambientHeaders }));

let M: typeof Mod;

beforeEach(async () => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({ ok: true });
  M = await import("@/lib/admin/auth-admin.server");
});
afterEach(() => vi.resetModules());

const actor = new Headers({ "x-actor": "1" });

describe("body + method routing", () => {
  it("createBetterAuthUser → createUser (name defaults to email)", async () => {
    await M.createBetterAuthUser({ email: "a@x.com", password: "pw", role: "admin" }, actor);
    expect(api.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ email: "a@x.com", name: "a@x.com", role: "admin" }),
      }),
    );
  });

  it("updateBetterAuthUser → updateUser", async () => {
    await M.updateBetterAuthUser({ userId: "u1", data: { name: "N" } }, actor);
    expect(api.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "u1", data: { name: "N" } } }),
    );
  });

  it("setBetterAuthUserRole → setRole", async () => {
    await M.setBetterAuthUserRole({ userId: "u1", role: "user" }, actor);
    expect(api.setRole).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "u1", role: "user" } }),
    );
  });

  it("setBetterAuthUserPassword → setUserPassword", async () => {
    await M.setBetterAuthUserPassword({ userId: "u1", newPassword: "secret" }, actor);
    expect(api.setUserPassword).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "u1", newPassword: "secret" } }),
    );
  });

  it("banBetterAuthUser → banUser with reason + expiry", async () => {
    await M.banBetterAuthUser({ userId: "u1", banReason: "abuse", banExpiresIn: 60 }, actor);
    expect(api.banUser).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "u1", banReason: "abuse", banExpiresIn: 60 } }),
    );
  });

  it("unbanBetterAuthUser → unbanUser", async () => {
    await M.unbanBetterAuthUser("u1", actor);
    expect(api.unbanUser).toHaveBeenCalledWith(expect.objectContaining({ body: { userId: "u1" } }));
  });

  it("session wrappers route to the matching api methods", async () => {
    await M.listBetterAuthUserSessions("u1", actor);
    await M.revokeBetterAuthUserSession("tok", actor);
    await M.revokeAllBetterAuthUserSessions("u1", actor);
    expect(api.listUserSessions).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "u1" } }),
    );
    expect(api.revokeUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ body: { sessionToken: "tok" } }),
    );
    expect(api.revokeUserSessions).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "u1" } }),
    );
  });

  it("impersonation wrappers route to impersonateUser / stopImpersonating", async () => {
    await M.impersonateBetterAuthUser("u1", actor);
    await M.stopBetterAuthImpersonating(actor);
    expect(api.impersonateUser).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: "u1" } }),
    );
    expect(api.stopImpersonating).toHaveBeenCalled();
  });

  it("sendBetterAuthPasswordResetEmail → requestPasswordReset", async () => {
    await M.sendBetterAuthPasswordResetEmail("a@x.com", "/back", actor);
    expect(api.requestPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: "a@x.com", redirectTo: "/back" } }),
    );
  });
});

describe("actor header forwarding", () => {
  it("forwards an explicit Headers instance", async () => {
    await M.unbanBetterAuthUser("u1", actor);
    expect(api.unbanUser.mock.calls[0]![0].headers).toBe(actor);
  });

  it("unwraps a { headers } request handle", async () => {
    await M.unbanBetterAuthUser("u1", { headers: actor });
    expect(api.unbanUser.mock.calls[0]![0].headers).toBe(actor);
  });

  it("falls back to ambient next/headers() when no actor is given", async () => {
    await M.unbanBetterAuthUser("u1");
    expect(api.unbanUser.mock.calls[0]![0].headers).toBe(ambientHeaders);
  });
});

describe("response passthrough", () => {
  it("returns the plugin response untouched", async () => {
    api.banUser.mockResolvedValue({ user: { id: "u1", banned: true } });
    await expect(M.banBetterAuthUser({ userId: "u1", banReason: "x" }, actor)).resolves.toEqual({
      user: { id: "u1", banned: true },
    });
  });
});
