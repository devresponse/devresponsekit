import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Mod from "@/lib/admin/auth-admin.server";
import { CLIENT_IP_HEADER, getClientIp } from "@/lib/client-ip";

/**
 * Unit tests for the Better Auth admin wrappers. Since F-13 they come in two
 * kinds, and these tests pin which is which:
 *
 *   - The user-administration wrappers write through Better Auth's internal
 *     adapter (`auth.$context`) and never read the caller's headers: the
 *     route's guard is the authority, so a bearer caller works like a cookie
 *     caller. `createBetterAuthUser` is the endpoint called WITHOUT headers.
 *   - Impersonation and the reset email still forward the actor's headers
 *     (explicit `Headers`, `{ headers }`, or the ambient `next/headers()`),
 *     stamped with the trusted client IP (review #35).
 *
 * The real writes against the real plugin are proven in
 * tests/security/admin-wrappers-real-plugin.test.ts; here the adapter is a
 * stub, so the ORDER of the containment steps (F-08, F-10) can be asserted.
 */
const api = {
  createUser: vi.fn(),
  impersonateUser: vi.fn(),
  stopImpersonating: vi.fn(),
  requestPasswordReset: vi.fn(),
};
const adapter = {
  findUserById: vi.fn(),
  updateUser: vi.fn(),
  deleteUserSessions: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  findCredentialAccount: vi.fn(),
  updatePassword: vi.fn(),
  createAccount: vi.fn(),
};
const password = {
  hash: vi.fn(),
  config: { minPasswordLength: 8, maxPasswordLength: 128 },
};
const ambientHeaders = new Headers({ "x-ambient": "1" });

// Mocking @/lib/auth keeps the real Better Auth + pgPool chain out. `api` holds
// ONLY the four vendor endpoints the module may call: any other `auth.api.*`
// call would throw here.
vi.mock("@/lib/auth", () => ({
  auth: {
    api,
    get $context() {
      return Promise.resolve({ internalAdapter: adapter, password });
    },
  },
}));
// F-08: the containment wrappers also end the sessions the user opened as
// someone else. Stubbed here so the call — and its ORDER relative to the
// primary write — can be asserted; the real delete is exercised against the
// real plugin in tests/security/impersonation-containment.test.ts.
const revokeSessionsImpersonatedBy = vi.fn();
vi.mock("@/lib/impersonation-sessions.server", () => ({
  revokeSessionsImpersonatedBy: (...a: unknown[]) => revokeSessionsImpersonatedBy(...a),
}));
// F-10: set-password also revokes the user's bearer credentials. Stubbed for
// the same reason; its SQL is proven in tests/db/credential-eviction.db.test.ts.
const revokeBearerCredentialsOf = vi.fn();
vi.mock("@/lib/api-auth/credential-eviction.server", () => ({
  revokeBearerCredentialsOf: (...a: unknown[]) => revokeBearerCredentialsOf(...a),
}));
vi.mock("next/headers", () => ({ headers: async () => ambientHeaders }));

let M: typeof Mod;

const TARGET = { id: "u1", email: "u1@example.com", name: "U1" };

beforeEach(async () => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({ ok: true });
  for (const fn of Object.values(adapter)) fn.mockReset().mockResolvedValue(undefined);
  adapter.findUserById.mockResolvedValue(TARGET);
  adapter.updateUser.mockImplementation(async (id: string, data: object) => ({ id, ...data }));
  adapter.listSessions.mockResolvedValue([]);
  adapter.findCredentialAccount.mockResolvedValue({ id: "acc-1", providerId: "credential" });
  password.hash.mockReset().mockResolvedValue("hashed-secret");
  revokeSessionsImpersonatedBy.mockReset().mockResolvedValue(0);
  revokeBearerCredentialsOf.mockReset().mockResolvedValue({ apiKeyIds: [], oauthClientIds: [] });
  M = await import("@/lib/admin/auth-admin.server");
});
afterEach(() => vi.resetModules());

const actor = new Headers({ "x-actor": "1" });
const setBy = { betterAuthUserId: "ba-admin", appUserId: "app-admin", requestId: "req-1" };
const ban = { userId: "u1", banReason: "abuse", actorBetterAuthUserId: "ba-admin" };

describe("F-13: user administration is a trusted server call, whoever the caller is", () => {
  it("createBetterAuthUser calls the endpoint with NO headers (name defaults to email)", async () => {
    await M.createBetterAuthUser({ email: "a@x.com", password: "pw-long-enough", role: "admin" });

    const [arg] = api.createUser.mock.calls[0]! as [Record<string, unknown>];
    // A call with no request and no headers is the plugin's trusted server
    // call. With the caller's headers it demanded a cookie session holding
    // the Better Auth `admin` role, so every bearer caller got a 502.
    expect(Object.keys(arg)).toEqual(["body"]);
    expect(arg.body).toMatchObject({ email: "a@x.com", name: "a@x.com", role: "admin" });
  });

  it("F-03: marks an admin-created identity as having NO mailbox proof by default", async () => {
    await M.createBetterAuthUser({ email: "a@x.com", password: "pw-long-enough" });
    expect(api.createUser).toHaveBeenCalledWith({
      body: expect.objectContaining({
        data: expect.objectContaining({ emailVerified: true, emailVerificationWaived: true }),
      }),
    });
  });

  it("F-03: leaves the marker off only when the caller vouches (emailUnproven: false)", async () => {
    await M.createBetterAuthUser({
      email: "a@x.com",
      password: "pw-long-enough",
      emailUnproven: false,
    });
    expect(api.createUser).toHaveBeenCalledWith({
      body: expect.objectContaining({
        data: expect.objectContaining({ emailVerificationWaived: false }),
      }),
    });
  });

  it("createBetterAuthUser builds `data` itself: nothing smuggled beside the params reaches the plugin", async () => {
    // Headerless, the plugin takes `data.role` when `role` is absent and skips
    // its ban-field check, and the adapter writes whatever `data` holds. A
    // passthrough would mint the platform role, pre-ban the user or clear the
    // F-03 marker with no guard at all.
    await M.createBetterAuthUser({
      email: "a@x.com",
      password: "pw-long-enough",
      data: { role: "admin", banned: true, emailVerificationWaived: false },
    } as unknown as Mod.CreateUserParams);

    const [arg] = api.createUser.mock.calls[0]! as [{ body: Record<string, unknown> }];
    expect(arg.body.role).toBeUndefined();
    expect(arg.body.data).toEqual({ emailVerified: true, emailVerificationWaived: true });
  });

  it("updateBetterAuthUser writes the TARGET's name through the adapter (F-14)", async () => {
    await M.updateBetterAuthUser({ userId: "u1", data: { name: "N" } });
    // Not the self-service `/update-user`, which renames the session's own user.
    expect(adapter.updateUser).toHaveBeenCalledWith("u1", { name: "N" });
  });

  it("updateBetterAuthUser writes only the name, whatever the caller smuggles in", async () => {
    await M.updateBetterAuthUser({
      userId: "u1",
      data: { name: "N", role: "admin", banned: false } as unknown as { name: string },
    });
    expect(adapter.updateUser).toHaveBeenCalledWith("u1", { name: "N" });
  });

  it("setBetterAuthUserRole writes the role", async () => {
    await expect(M.setBetterAuthUserRole({ userId: "u1", role: "admin" })).resolves.toEqual({
      user: { id: "u1", role: "admin" },
    });
    expect(adapter.updateUser).toHaveBeenCalledWith("u1", { role: "admin" });
  });

  it("banBetterAuthUser writes the ban with its expiry, then deletes the user's sessions", async () => {
    const before = Date.now();
    await M.banBetterAuthUser({ ...ban, banExpiresIn: 60 });

    const [id, data] = adapter.updateUser.mock.calls[0]! as [string, Record<string, unknown>];
    expect(id).toBe("u1");
    expect(data).toMatchObject({ banned: true, banReason: "abuse" });
    const expires = (data.banExpires as Date).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(adapter.deleteUserSessions).toHaveBeenCalledWith("u1");
  });

  it("banBetterAuthUser without an expiry bans indefinitely, with Better Auth's default reason", async () => {
    await M.banBetterAuthUser({ userId: "u1", actorBetterAuthUserId: "ba-admin" });
    expect(adapter.updateUser).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ banned: true, banReason: "No reason", banExpires: null }),
    );
  });

  it("banBetterAuthUser refuses a ban of oneself before writing anything", async () => {
    await expect(M.banBetterAuthUser({ ...ban, actorBetterAuthUserId: "u1" })).rejects.toThrow(
      "You cannot ban yourself",
    );
    expect(adapter.updateUser).not.toHaveBeenCalled();
    expect(adapter.deleteUserSessions).not.toHaveBeenCalled();
    expect(revokeSessionsImpersonatedBy).not.toHaveBeenCalled();
  });

  it("unbanBetterAuthUser clears the ban", async () => {
    await M.unbanBetterAuthUser("u1");
    expect(adapter.updateUser).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ banned: false, banReason: null, banExpires: null }),
    );
  });

  it("every write to a user refuses a missing one (USER_NOT_FOUND) and writes nothing", async () => {
    adapter.findUserById.mockResolvedValue(null);
    const writes = [
      () => M.updateBetterAuthUser({ userId: "u1", data: { name: "N" } }),
      () => M.setBetterAuthUserRole({ userId: "u1", role: "user" }),
      () => M.banBetterAuthUser(ban),
      () => M.unbanBetterAuthUser("u1"),
      () => M.setBetterAuthUserPassword({ userId: "u1", newPassword: "secret-long", setBy }),
    ];
    for (const write of writes) await expect(write()).rejects.toThrow("User not found");
    expect(adapter.updateUser).not.toHaveBeenCalled();
    expect(adapter.updatePassword).not.toHaveBeenCalled();
    expect(adapter.deleteUserSessions).not.toHaveBeenCalled();
  });

  it("the session wrappers list, revoke one and revoke all through the adapter", async () => {
    adapter.listSessions.mockResolvedValue([{ id: "s1", token: "tok" }]);
    await expect(M.listBetterAuthUserSessions("u1")).resolves.toEqual({
      sessions: [{ id: "s1", token: "tok" }],
    });
    await M.revokeBetterAuthUserSession("tok");
    await M.revokeAllBetterAuthUserSessions("u1");
    expect(adapter.listSessions).toHaveBeenCalledWith("u1");
    expect(adapter.deleteSession).toHaveBeenCalledWith("tok");
    expect(adapter.deleteUserSessions).toHaveBeenCalledWith("u1");
  });

  it("setBetterAuthUserPassword hashes with Better Auth's hasher into the credential account", async () => {
    await expect(
      M.setBetterAuthUserPassword({ userId: "u1", newPassword: "secret-long", setBy }, actor),
    ).resolves.toEqual({ status: true });
    expect(password.hash).toHaveBeenCalledWith("secret-long");
    expect(adapter.updatePassword).toHaveBeenCalledWith("u1", "hashed-secret");
    expect(adapter.createAccount).not.toHaveBeenCalled();
  });

  it("setBetterAuthUserPassword creates the credential account a social-only user lacks", async () => {
    adapter.findCredentialAccount.mockResolvedValue(null);
    await M.setBetterAuthUserPassword({ userId: "u1", newPassword: "secret-long", setBy }, actor);
    expect(adapter.createAccount).toHaveBeenCalledWith({
      userId: "u1",
      providerId: "credential",
      accountId: "u1",
      password: "hashed-secret",
    });
    expect(adapter.updatePassword).not.toHaveBeenCalled();
  });

  it.each([
    ["too short", "short", "Password too short"],
    ["too long", "x".repeat(129), "Password too long"],
  ])(
    "setBetterAuthUserPassword refuses a password %s (Better Auth's bounds)",
    async (_label, pw, message) => {
      await expect(
        M.setBetterAuthUserPassword({ userId: "u1", newPassword: pw, setBy }, actor),
      ).rejects.toThrow(message);
      expect(password.hash).not.toHaveBeenCalled();
      expect(adapter.deleteUserSessions).not.toHaveBeenCalled();
    },
  );
});

describe("impersonation and the reset email forward the actor's headers", () => {
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

  it("forwards an explicit Headers instance (as a stamped copy)", async () => {
    await M.impersonateBetterAuthUser("u1", actor);
    const passed = api.impersonateUser.mock.calls[0]![0].headers as Headers;
    expect(passed.get("x-actor")).toBe("1");
    expect(passed).not.toBe(actor);
  });

  it("unwraps a { headers } request handle", async () => {
    await M.sendBetterAuthPasswordResetEmail("a@x.com", undefined, { headers: actor });
    expect((api.requestPasswordReset.mock.calls[0]![0].headers as Headers).get("x-actor")).toBe(
      "1",
    );
  });

  it("falls back to ambient next/headers() when no actor is given", async () => {
    await M.stopBetterAuthImpersonating();
    expect((api.stopImpersonating.mock.calls[0]![0].headers as Headers).get("x-ambient")).toBe("1");
  });

  it("returns the plugin response untouched", async () => {
    api.impersonateUser.mockResolvedValue({ session: { id: "s" }, user: { id: "u1" } });
    await expect(M.impersonateBetterAuthUser("u1", actor)).resolves.toEqual({
      session: { id: "s" },
      user: { id: "u1" },
    });
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

/**
 * F-08 — Better Auth ends "a user's sessions" by `userId`, and an
 * impersonation session carries the TARGET's id there. Each containment
 * wrapper must therefore also end the sessions the user opened AS SOMEONE
 * ELSE — after the primary write succeeded, and never when it failed.
 */
describe("F-08: containment wrappers end the user's impersonation sessions", () => {
  const containment = [
    {
      name: "banBetterAuthUser",
      primary: adapter.updateUser,
      run: () => M.banBetterAuthUser({ ...ban, banReason: "compromised" }),
    },
    {
      name: "revokeAllBetterAuthUserSessions",
      primary: adapter.deleteUserSessions,
      run: () => M.revokeAllBetterAuthUserSessions("u1"),
    },
    {
      name: "setBetterAuthUserPassword",
      primary: adapter.updatePassword,
      run: () => M.setBetterAuthUserPassword({ userId: "u1", newPassword: "secret-long", setBy }),
    },
  ];

  it.each(containment)("$name ends them, AFTER the primary write", async ({ primary, run }) => {
    const order: string[] = [];
    primary.mockImplementation(async () => {
      order.push("primary");
      return { id: "u1" };
    });
    revokeSessionsImpersonatedBy.mockImplementation(async () => {
      order.push("impersonations");
      return 1;
    });

    await run();

    expect(revokeSessionsImpersonatedBy).toHaveBeenCalledWith("u1");
    expect(order).toEqual(["primary", "impersonations"]);
  });

  it.each(containment)(
    "$name signs nobody out when the primary write fails",
    async ({ primary, run }) => {
      primary.mockRejectedValue(new Error("db refused the write"));

      await expect(run()).rejects.toThrow("db refused the write");
      expect(revokeSessionsImpersonatedBy).not.toHaveBeenCalled();
    },
  );

  it.each(containment)(
    "$name reports failure when the borrowed sessions could not be ended",
    async ({ run }) => {
      // The route turns this into its 502 + failure audit, so the operator
      // retries instead of believing the admin is contained.
      revokeSessionsImpersonatedBy.mockRejectedValue(new Error("db down"));

      await expect(run()).rejects.toThrow("db down");
    },
  );

  it("non-containment wrappers leave impersonation sessions alone", async () => {
    await M.unbanBetterAuthUser("u1");
    await M.setBetterAuthUserRole({ userId: "u1", role: "user" });
    await M.updateBetterAuthUser({ userId: "u1", data: { name: "N" } });
    await M.revokeBetterAuthUserSession("tok");
    await M.listBetterAuthUserSessions("u1");

    expect(revokeSessionsImpersonatedBy).not.toHaveBeenCalled();
  });
});

/**
 * F-10 — setting a password deletes none of the user's sessions and touches
 * no app credential on its own. A new password set by an operator is the
 * compromise response, so the wrapper ends the user's OWN sessions too and
 * revokes the bearer credentials that authenticate as them, in that order,
 * each only after the step before it succeeded.
 */
describe("F-10: set-password ends everything that authenticated with the old password", () => {
  const run = () =>
    M.setBetterAuthUserPassword({ userId: "u1", newPassword: "secret-long", setBy }, actor);

  it("sets, then ends the user's own sessions, then the borrowed ones, then the credentials", async () => {
    const order: string[] = [];
    const step = (name: string, value: unknown) => async () => {
      order.push(name);
      return value;
    };
    adapter.updatePassword.mockImplementation(step("set", undefined));
    adapter.deleteUserSessions.mockImplementation(step("own-sessions", undefined));
    revokeSessionsImpersonatedBy.mockImplementation(step("borrowed-sessions", 1));
    revokeBearerCredentialsOf.mockImplementation(
      step("credentials", { apiKeyIds: ["k1"], oauthClientIds: [] }),
    );

    await expect(run()).resolves.toEqual({ status: true });

    expect(order).toEqual(["set", "own-sessions", "borrowed-sessions", "credentials"]);
    expect(adapter.deleteUserSessions).toHaveBeenCalledWith("u1");
  });

  it("revokes the credentials in the ADMIN's name, correlated with the route's request", async () => {
    await run();

    expect(revokeBearerCredentialsOf).toHaveBeenCalledWith({
      betterAuthUserId: "u1",
      trigger: "password_set",
      actorBetterAuthUserId: "ba-admin",
      revokedByAppUserId: "app-admin",
      requestId: "req-1",
      // The ORIGINAL headers object, not a stamped copy: F-07 attribution is
      // keyed on it.
      request: { headers: actor },
    });
    expect(revokeBearerCredentialsOf.mock.calls[0]![0].request.headers).toBe(actor);
  });

  it("audits against the ambient request when the caller passes none", async () => {
    await M.setBetterAuthUserPassword({ userId: "u1", newPassword: "secret-long", setBy });

    expect(revokeBearerCredentialsOf.mock.calls[0]![0].request.headers).toBe(ambientHeaders);
  });

  it("revokes nothing when the password is refused", async () => {
    await expect(
      M.setBetterAuthUserPassword({ userId: "u1", newPassword: "short", setBy }, actor),
    ).rejects.toThrow("Password too short");
    expect(adapter.deleteUserSessions).not.toHaveBeenCalled();
    expect(revokeBearerCredentialsOf).not.toHaveBeenCalled();
  });

  it("reports failure, and revokes no credential, when the user's sessions could not be ended", async () => {
    adapter.deleteUserSessions.mockRejectedValue(new Error("db down"));

    await expect(run()).rejects.toThrow("db down");
    expect(revokeBearerCredentialsOf).not.toHaveBeenCalled();
  });

  it("reports failure when the credentials could not be revoked", async () => {
    // The route turns this into its 502 + failure audit, so the operator
    // retries instead of believing the account is contained.
    revokeBearerCredentialsOf.mockRejectedValue(new Error("db down"));

    await expect(run()).rejects.toThrow("db down");
  });

  it("no other wrapper revokes bearer credentials", async () => {
    // A ban already stops them at resolution (AUTH-1) and an unban restores
    // them; "revoke all sessions" is about sessions. Only a new password is a
    // statement that the old credential is compromised.
    await M.banBetterAuthUser(ban);
    await M.revokeAllBetterAuthUserSessions("u1");
    await M.unbanBetterAuthUser("u1");

    expect(revokeBearerCredentialsOf).not.toHaveBeenCalled();
  });
});
