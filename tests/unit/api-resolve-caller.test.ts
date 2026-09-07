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
const isSourceCredentialActive = vi.fn();
const getCurrentSession = vi.fn();
const getUserAccessContext = vi.fn();
const isBetterAuthUserBanned = vi.fn();

/** Mirrors the typed audience failure jwt.server throws (review #50/#53). */
class AccessTokenAudienceError extends Error {
  constructor() {
    super("aud");
    this.name = "AccessTokenAudienceError";
  }
}

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
  AccessTokenAudienceError,
}));
vi.mock("@/lib/api-auth/revocation.server", () => ({
  isSourceCredentialActive: (...a: unknown[]) => isSourceCredentialActive(...a),
}));

const ISSUED_AT = new Date("2026-09-05T10:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-05T10:15:00.000Z");
/** A verified token as jwt.server returns it, with the `cid` claim present. */
const verifiedToken = (over: Record<string, unknown> = {}) => ({
  subject: "ba1",
  jti: "j1",
  organizationId: "org-b",
  scopes: ["admin.users.read"],
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  audience: ["devresponse-api"],
  credential: { kind: "api_key", id: "key-1" },
  ...over,
});
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
    isSourceCredentialActive,
    getCurrentSession,
    getUserAccessContext,
    isBetterAuthUserBanned,
  ])
    m.mockReset();
  getUserAccessContext.mockResolvedValue(ACCESS);
  isBetterAuthUserBanned.mockResolvedValue(false);
  isSourceCredentialActive.mockResolvedValue(true);
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

  it("returns null for a non-Bearer or empty-token Authorization header", () => {
    // Not a Bearer scheme → no match.
    expect(mod.readBearerToken(new Headers({ authorization: "Basic dXNlcjpwdw==" }))).toBeNull();
    // `Bearer` with only whitespace after it → the (.+) capture is empty → null.
    expect(mod.readBearerToken(new Headers({ authorization: "Bearer    " }))).toBeNull();
    expect(mod.hasBearerCredential(new Headers({ authorization: "Bearer   " }))).toBe(false);
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
      // A cookie is not a bound credential (review #207).
      boundOrganizationId: null,
      impersonatorId: null,
    });
  });

  it("surfaces the impersonating admin on an impersonation session (review #28 / P0-1)", async () => {
    // The admin plugin stamps `impersonatedBy` on the session row; the account
    // guard consumers (active-org switch) refuse such callers from this field
    // without a second session lookup.
    getCurrentSession.mockResolvedValue({
      user: { id: "target" },
      session: { id: "s-imp", impersonatedBy: "admin-9" },
    });
    const caller = await mod.resolveCaller(req());
    expect(caller).toMatchObject({ kind: "session", impersonatorId: "admin-9" });
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
      // The key's own binding rides along, verbatim (review #207).
      boundOrganizationId: "org-a",
      // A minted credential is never an impersonation (review #28).
      impersonatorId: null,
    });
  });

  it("carries the KEY's bound org even when the principal is not a member of it (review #207)", async () => {
    env.API_KEYS_ENABLED = true;
    verifyApiKey.mockResolvedValue({
      id: "k1",
      betterAuthUserId: "ba1",
      organizationId: "org-a",
      scopes: ["admin.users.read"],
    });
    // The fail-closed case: the principal holds no membership in the bound org,
    // so getUserAccessContext resolves `access.organizationId` to null.
    // `boundOrganizationId` must STILL be the credential's binding — the MCP
    // gateway re-mints it into the token of its own /api/v1 self-call, and
    // re-deriving it from `access` would turn "bound to an org I am not a
    // member of" into "bound to nothing", letting the v1 fallback act in the
    // principal's earliest org instead of denying.
    getUserAccessContext.mockResolvedValue({ ...ACCESS, organizationId: null });
    const caller = await mod.resolveCaller(req("Bearer drk_live_abc"));
    expect(caller?.boundOrganizationId).toBe("org-a");
    expect(caller?.access.organizationId).toBeNull();
  });

  it("leaves boundOrganizationId null for an org-less key", async () => {
    env.API_KEYS_ENABLED = true;
    verifyApiKey.mockResolvedValue({
      id: "k1",
      betterAuthUserId: "ba1",
      organizationId: null,
      scopes: ["admin.users.read"],
    });
    expect((await mod.resolveCaller(req("Bearer drk_live_abc")))?.boundOrganizationId).toBeNull();
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

  it("resolves a valid token from an active credential to a jwt caller", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(verifiedToken());
    const caller = await mod.resolveCaller(req("Bearer eyJ.token.sig"));
    expect(caller).toMatchObject({
      kind: "jwt",
      credentialId: "j1",
      isBearer: true,
      // The `org` claim is the binding the gateway re-mints (review #207).
      boundOrganizationId: "org-b",
      impersonatorId: null,
    });
    // The token's own claims ride along for the MCP gateway's exchange.
    expect(caller?.jwt).toEqual({
      organizationId: "org-b",
      expiresAt: EXPIRES_AT,
      audience: ["devresponse-api"],
      credential: { kind: "api_key", id: "key-1" },
    });
  });

  it("resolves against the token's bound org claim, not the active_org cookie (MACHINE-1)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(verifiedToken());
    await mod.resolveCaller(req("Bearer eyJ.token.sig"));
    expect(getUserAccessContext).toHaveBeenCalledWith("ba1", { organizationId: "org-b" });
  });

  it("carries the TOKEN's `org` claim even when the principal is not a member of it (review #207)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(verifiedToken());
    // Same fail-closed case as the API-key path: no membership in the bound
    // org → `access.organizationId` is null, but the binding the MCP gateway
    // re-mints into its self-call token must survive intact.
    getUserAccessContext.mockResolvedValue({ ...ACCESS, organizationId: null });
    const caller = await mod.resolveCaller(req("Bearer eyJ.token.sig"));
    expect(caller?.boundOrganizationId).toBe("org-b");
    expect(caller?.access.organizationId).toBeNull();
  });

  it("leaves boundOrganizationId null for a token with no `org` claim", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(verifiedToken({ organizationId: null }));
    expect((await mod.resolveCaller(req("Bearer eyJ.token.sig")))?.boundOrganizationId).toBeNull();
  });

  it("re-checks the SOURCE credential on every request and rejects once it is revoked (review #43)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(verifiedToken());
    // First request: the key is still active → 200-path.
    isSourceCredentialActive.mockResolvedValueOnce(true);
    expect(await mod.resolveCaller(req("Bearer eyJ.token.sig"))).not.toBeNull();
    // The key is revoked in between; the SAME (still signature-valid,
    // unexpired) token must now be refused with the distinct reason.
    isSourceCredentialActive.mockResolvedValueOnce(false);
    const result = await mod.resolveCallerDetailed(req("Bearer eyJ.token.sig"));
    expect(result).toEqual({ ok: false, reason: "credential_revoked" });
    expect(isSourceCredentialActive).toHaveBeenCalledTimes(2);
    expect(isSourceCredentialActive).toHaveBeenLastCalledWith(
      { kind: "api_key", id: "key-1" },
      ISSUED_AT,
    );
    // Nothing downstream of the revocation check ran for the dead token.
    expect(isBetterAuthUserBanned).toHaveBeenCalledTimes(1);
  });

  it("rejects a token whose OAuth client was revoked or rotated with credential_revoked", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(
      verifiedToken({ credential: { kind: "oauth_client", id: "client-9" } }),
    );
    isSourceCredentialActive.mockResolvedValue(false);
    expect(await mod.resolveCallerDetailed(req("Bearer eyJ.token.sig"))).toEqual({
      ok: false,
      reason: "credential_revoked",
    });
    expect(isSourceCredentialActive).toHaveBeenCalledWith(
      { kind: "oauth_client", id: "client-9" },
      ISSUED_AT,
    );
  });

  it("honours a legacy token minted without a `cid` claim (it dies at exp on its own)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(verifiedToken({ credential: null }));
    const caller = await mod.resolveCaller(req("Bearer eyJ.token.sig"));
    expect(caller?.kind).toBe("jwt");
    expect(isSourceCredentialActive).not.toHaveBeenCalled();
  });

  it("passes the caller's expected audience through to verification (review #50/#53)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(verifiedToken({ audience: ["https://x/api/mcp"] }));
    await mod.resolveCaller(req("Bearer eyJ.token.sig"), {
      expectedAudience: ["https://x/api/mcp", "devresponse-api"],
    });
    expect(verifyAccessToken).toHaveBeenCalledWith("eyJ.token.sig", {
      expectedAudience: ["https://x/api/mcp", "devresponse-api"],
    });
    // No option → the default (v1) audience is left to jwt.server.
    await mod.resolveCaller(req("Bearer eyJ.token.sig"));
    expect(verifyAccessToken).toHaveBeenLastCalledWith("eyJ.token.sig", {
      expectedAudience: undefined,
    });
  });

  it("reports a wrong-audience token as audience_mismatch, distinct from an invalid one", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockRejectedValueOnce(new AccessTokenAudienceError());
    expect(await mod.resolveCallerDetailed(req("Bearer eyJ.token.sig"))).toEqual({
      ok: false,
      reason: "audience_mismatch",
    });
    verifyAccessToken.mockRejectedValueOnce(new Error("signature verification failed"));
    expect(await mod.resolveCallerDetailed(req("Bearer eyJ.bad.sig"))).toEqual({
      ok: false,
      reason: "invalid_credential",
    });
  });

  it("returns null when the token subject is banned (AUTH-1)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockResolvedValue(verifiedToken());
    isBetterAuthUserBanned.mockResolvedValue(true);
    expect(await mod.resolveCallerDetailed(req("Bearer eyJ.token.sig"))).toEqual({
      ok: false,
      reason: "principal_banned",
    });
    expect(isBetterAuthUserBanned).toHaveBeenCalledWith("ba1");
    expect(getUserAccessContext).not.toHaveBeenCalled();
  });

  it("returns null when verification throws (invalid/expired)", async () => {
    env.API_JWT_ENABLED = true;
    verifyAccessToken.mockRejectedValue(new Error("expired"));
    expect(await mod.resolveCaller(req("Bearer eyJ.bad.sig"))).toBeNull();
  });
});

describe("resolveCallerDetailed — rejection reasons for the other paths", () => {
  it("names a disabled path, an invalid key, a banned key owner and a missing credential", async () => {
    expect(await mod.resolveCallerDetailed(req("Bearer drk_live_abc"))).toEqual({
      ok: false,
      reason: "path_disabled",
    });
    expect(await mod.resolveCallerDetailed(req("Bearer eyJ.token.sig"))).toEqual({
      ok: false,
      reason: "path_disabled",
    });
    env.API_KEYS_ENABLED = true;
    verifyApiKey.mockResolvedValue(null);
    expect(await mod.resolveCallerDetailed(req("Bearer drk_live_bad"))).toEqual({
      ok: false,
      reason: "invalid_credential",
    });
    verifyApiKey.mockResolvedValue({ id: "k1", betterAuthUserId: "ba1", scopes: [] });
    isBetterAuthUserBanned.mockResolvedValue(true);
    expect(await mod.resolveCallerDetailed(req("Bearer drk_live_abc"))).toEqual({
      ok: false,
      reason: "principal_banned",
    });
    getCurrentSession.mockResolvedValue(null);
    expect(await mod.resolveCallerDetailed(req())).toEqual({
      ok: false,
      reason: "no_credential",
    });
  });
});
