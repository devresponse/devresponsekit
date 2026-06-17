import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ResolveModule from "@/lib/api-auth/resolve-caller.server";

/**
 * Unit tests for the unified caller resolver
 * (`src/lib/api-auth/resolve-caller.server.ts`) — the single entry point
 * that understands every credential type. Pins the resolution order and
 * the feature-flag gating (API keys / JWT off → no bearer auth).
 */
const env = vi.hoisted(() => ({ API_KEYS_ENABLED: false, API_JWT_ENABLED: false }));
const verifyApiKey = vi.fn();
const verifyAccessToken = vi.fn();
const isJtiRevoked = vi.fn();
const getCurrentSession = vi.fn();
const getUserAccessContext = vi.fn();
const isBetterAuthUserBanned = vi.fn();

vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  verifyApiKey: (...a: unknown[]) => verifyApiKey(...a),
  touchApiKeyUsage: vi.fn(),
}));
vi.mock("@/lib/api-auth/ban-status.server", () => ({
  isBetterAuthUserBanned: (...a: unknown[]) => isBetterAuthUserBanned(...a),
}));
vi.mock("@/lib/api-auth/jwt.server", () => ({
  verifyAccessToken: (...a: unknown[]) => verifyAccessToken(...a),
}));
vi.mock("@/lib/api-auth/revocation.server", () => ({
  isJtiRevoked: (...a: unknown[]) => isJtiRevoked(...a),
}));
vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => getCurrentSession() }));
vi.mock("@/lib/auth-status", () => ({
  getUserAccessContext: (...a: unknown[]) => getUserAccessContext(...a),
}));

const ACCESS = { appUserId: "u1", permissions: ["admin.users.read"], status: "active" };

function req(authorization?: string): { headers: Headers } {
  return { headers: new Headers(authorization ? { authorization } : {}) };
}

let mod: typeof ResolveModule;

beforeEach(async () => {
  env.API_KEYS_ENABLED = false;
  env.API_JWT_ENABLED = false;
  for (const m of [
    verifyApiKey,
    verifyAccessToken,
    isJtiRevoked,
    getCurrentSession,
    getUserAccessContext,
    isBetterAuthUserBanned,
  ])
    m.mockReset();
  getUserAccessContext.mockResolvedValue(ACCESS);
  isBetterAuthUserBanned.mockResolvedValue(false);
  mod = await import("@/lib/api-auth/resolve-caller.server");
});
afterEach(() => vi.resetModules());

describe("readBearerToken / hasBearerCredential", () => {
  it("extracts a Bearer token case-insensitively, else null", () => {
    expect(mod.readBearerToken(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(mod.readBearerToken(new Headers({ Authorization: "bearer  xyz " }))).toBe("xyz");
    expect(mod.readBearerToken(new Headers())).toBeNull();
    expect(mod.hasBearerCredential(new Headers({ authorization: "Bearer t" }))).toBe(true);
    expect(mod.hasBearerCredential(new Headers())).toBe(false);
  });
});

describe("resolveCaller — cookie path", () => {
  it("returns a session caller (full authority, no scopes) when a session exists", async () => {
    getCurrentSession.mockResolvedValue({ user: { id: "ba1" } });
    const caller = await mod.resolveCaller(req());
    expect(caller).toMatchObject({
      kind: "session",
      betterAuthUserId: "ba1",
      grantedScopes: null,
      isBearer: false,
    });
  });

  it("returns null when no session and no token", async () => {
    getCurrentSession.mockResolvedValue(null);
    expect(await mod.resolveCaller(req())).toBeNull();
  });
});

describe("resolveCaller — API key path", () => {
  it("returns null when API keys are disabled", async () => {
    env.API_KEYS_ENABLED = false;
    expect(await mod.resolveCaller(req("Bearer drk_live_abc"))).toBeNull();
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it("resolves an enabled, valid key to an api_key caller carrying its scopes", async () => {
    env.API_KEYS_ENABLED = true;
    verifyApiKey.mockResolvedValue({
      id: "k1",
      betterAuthUserId: "ba1",
      organizationId: "org-a",
      scopes: ["admin.users.read"],
    });
    const caller = await mod.resolveCaller(req("Bearer drk_live_abc"));
    expect(caller).toMatchObject({
      kind: "api_key",
      isBearer: true,
      credentialId: "k1",
      grantedScopes: ["admin.users.read"],
    });
  });

  it("resolves against the key's bound org, not the active_org cookie (MACHINE-1)", async () => {
    env.API_KEYS_ENABLED = true;
    verifyApiKey.mockResolvedValue({
      id: "k1",
      betterAuthUserId: "ba1",
      organizationId: "org-a",
      scopes: ["admin.users.read"],
    });
    await mod.resolveCaller(req("Bearer drk_live_abc"));
    expect(getUserAccessContext).toHaveBeenCalledWith("ba1", { organizationId: "org-a" });
  });

  it("returns null when the key fails verification", async () => {
    env.API_KEYS_ENABLED = true;
    verifyApiKey.mockResolvedValue(null);
    expect(await mod.resolveCaller(req("Bearer drk_live_bad"))).toBeNull();
  });

  it("returns null when the key owner is banned (AUTH-1)", async () => {
    env.API_KEYS_ENABLED = true;
    verifyApiKey.mockResolvedValue({
      id: "k1",
      betterAuthUserId: "ba1",
      scopes: ["admin.users.read"],
    });
    isBetterAuthUserBanned.mockResolvedValue(true);
    expect(await mod.resolveCaller(req("Bearer drk_live_abc"))).toBeNull();
    expect(isBetterAuthUserBanned).toHaveBeenCalledWith("ba1");
    // A banned owner must never reach the access-context build step.
    expect(getUserAccessContext).not.toHaveBeenCalled();
  });
});

describe("resolveCaller — JWT path", () => {
  it("returns null when JWT is disabled", async () => {
    env.API_JWT_ENABLED = false;
    expect(await mod.resolveCaller(req("Bearer eyJhbGciOi.test.sig"))).toBeNull();
  });

  it("resolves a valid, non-revoked token to a jwt caller", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue({
      subject: "ba1",
      jti: "j1",
      organizationId: "org-b",
      scopes: ["admin.users.read"],
    });
    isJtiRevoked.mockResolvedValue(false);
    const caller = await mod.resolveCaller(req("Bearer eyJ.token.sig"));
    expect(caller).toMatchObject({ kind: "jwt", credentialId: "j1", isBearer: true });
  });

  it("resolves against the token's bound org claim, not the active_org cookie (MACHINE-1)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue({
      subject: "ba1",
      jti: "j1",
      organizationId: "org-b",
      scopes: ["admin.users.read"],
    });
    isJtiRevoked.mockResolvedValue(false);
    await mod.resolveCaller(req("Bearer eyJ.token.sig"));
    expect(getUserAccessContext).toHaveBeenCalledWith("ba1", { organizationId: "org-b" });
  });

  it("returns null when the token's jti is revoked", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue({ subject: "ba1", jti: "j1", scopes: [] });
    isJtiRevoked.mockResolvedValue(true);
    expect(await mod.resolveCaller(req("Bearer eyJ.token.sig"))).toBeNull();
  });

  it("returns null when the token subject is banned (AUTH-1)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue({ subject: "ba1", jti: "j1", scopes: [] });
    isJtiRevoked.mockResolvedValue(false);
    isBetterAuthUserBanned.mockResolvedValue(true);
    expect(await mod.resolveCaller(req("Bearer eyJ.token.sig"))).toBeNull();
    expect(isBetterAuthUserBanned).toHaveBeenCalledWith("ba1");
    expect(getUserAccessContext).not.toHaveBeenCalled();
  });

  it("returns null when verification throws (invalid/expired)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockRejectedValue(new Error("expired"));
    expect(await mod.resolveCaller(req("Bearer eyJ.bad.sig"))).toBeNull();
  });
});
