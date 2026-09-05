import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Mod from "@/lib/admin/auth-admin.server";
import { CLIENT_IP_HEADER, getClientIp } from "@/lib/client-ip";

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
  it("forwards an explicit Headers instance (as a stamped copy)", async () => {
    await M.unbanBetterAuthUser("u1", actor);
    const passed = api.unbanUser.mock.calls[0]![0].headers as Headers;
    expect(passed.get("x-actor")).toBe("1");
    expect(passed).not.toBe(actor);
  });

  it("unwraps a { headers } request handle", async () => {
    await M.unbanBetterAuthUser("u1", { headers: actor });
    expect((api.unbanUser.mock.calls[0]![0].headers as Headers).get("x-actor")).toBe("1");
  });

  it("falls back to ambient next/headers() when no actor is given", async () => {
    await M.unbanBetterAuthUser("u1");
    expect((api.unbanUser.mock.calls[0]![0].headers as Headers).get("x-ambient")).toBe("1");
  });
});

/**
 * Review #35 (follow-up): `/api/administrator/*` is outside the proxy
 * matcher, and `impersonateUser` CREATES a session whose `ipAddress` Better
 * Auth reads from `x-drk-client-ip` only. The wrappers must derive that
 * header from the trusted hop themselves — never forward an actor-supplied
 * value — and must not mutate the (read-only) source headers.
 */
describe("trusted client-IP header on every forwarded call (review #35)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("impersonateUser: overwrites an actor-injected x-drk-client-ip with the trusted hop", async () => {
    const request = {
      headers: new Headers({
        cookie: "ba.session=x",
        [CLIENT_IP_HEADER]: "6.6.6.6",
        "x-forwarded-for": "6.6.6.6, 203.0.113.9",
      }),
    };
    await M.impersonateBetterAuthUser("u1", request);
    const passed = api.impersonateUser.mock.calls[0]![0].headers as Headers;
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(passed.get("cookie")).toBe("ba.session=x");
    // Same address the audit row for this action records.
    expect(passed.get(CLIENT_IP_HEADER)).toBe(getClientIp(request.headers));
    // The route's request headers are left as they arrived.
    expect(request.headers.get(CLIENT_IP_HEADER)).toBe("6.6.6.6");
  });

  it("impersonateUser: an honest single-hop XFF still yields a real session IP", async () => {
    await M.impersonateBetterAuthUser("u1", new Headers({ "x-forwarded-for": "203.0.113.9" }));
    const passed = api.impersonateUser.mock.calls[0]![0].headers as Headers;
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("strips an injected header when nothing trustworthy is present (fail closed)", async () => {
    await M.impersonateBetterAuthUser("u1", new Headers({ [CLIENT_IP_HEADER]: "6.6.6.6" }));
    const passed = api.impersonateUser.mock.calls[0]![0].headers as Headers;
    expect(passed.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("honors TRUSTED_PROXY_COUNT like the app's own limiter", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    await M.stopBetterAuthImpersonating(
      new Headers({ "x-forwarded-for": "spoof, 203.0.113.9, 10.0.0.2" }),
    );
    const passed = api.stopImpersonating.mock.calls[0]![0].headers as Headers;
    expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });

  it("stamps the ambient next/headers() store too, without mutating it", async () => {
    ambientHeaders.set(CLIENT_IP_HEADER, "6.6.6.6");
    ambientHeaders.set("x-forwarded-for", "6.6.6.6, 203.0.113.9");
    try {
      await M.impersonateBetterAuthUser("u1");
      const passed = api.impersonateUser.mock.calls[0]![0].headers as Headers;
      expect(passed.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
      expect(passed.get("x-ambient")).toBe("1");
      expect(ambientHeaders.get(CLIENT_IP_HEADER)).toBe("6.6.6.6");
    } finally {
      ambientHeaders.delete(CLIENT_IP_HEADER);
      ambientHeaders.delete("x-forwarded-for");
    }
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
