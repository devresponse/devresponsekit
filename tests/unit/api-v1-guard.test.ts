import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as GuardModule from "@/lib/api-auth/v1-guard.server";

/**
 * Unit tests for the `/api/v1` authorization guard
 * (`src/lib/api-auth/v1-guard.server.ts`). Pins the four outcomes — origin
 * reject (cookie only), unauthenticated 401, blocked/insufficient 403
 * (audited), and granted — plus per-credential rate limiting. The caller
 * resolver is mocked so we exercise the guard's own decision logic.
 */
const resolveCaller = vi.fn();
const hasBearerCredential = vi.fn();
const checkTrustedOrigin = vi.fn();
const auditEvent = vi.fn();
const consumeToken = vi.fn();

vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCaller: (...a: unknown[]) => resolveCaller(...a),
  // The guard consumes the detailed form (review #43/#50). The mock accepts
  // either a plain caller / null (legacy cases) or an explicit resolution
  // object so the reason-specific 401s can be pinned.
  resolveCallerDetailed: async (...a: unknown[]) => {
    const r = (await resolveCaller(...a)) as unknown;
    if (r && typeof r === "object" && "ok" in r) return r;
    return r ? { ok: true, caller: r } : { ok: false, reason: "no_credential" };
  },
  hasBearerCredential: (...a: unknown[]) => hasBearerCredential(...a),
}));
vi.mock("@/lib/admin/origin-guard.server", () => ({
  checkTrustedOrigin: (...a: unknown[]) => checkTrustedOrigin(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/admin/request-id.server", () => ({
  getOrCreateRequestId: () => "req-1",
  REQUEST_ID_HEADER: "x-request-id",
}));
vi.mock("@/lib/admin/rate-limit.server", () => ({
  consumeToken: (...a: unknown[]) => consumeToken(...a),
  rateLimitKey: (scope: string, id: string) => `${scope}:${id}`,
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 10, refillPerSecond: 1 },
}));

function makeReq(): NextRequest {
  return {
    headers: new Headers(),
    nextUrl: new URL("http://t.local/api/v1/users"),
  } as unknown as NextRequest;
}

const caller = (over: Record<string, unknown> = {}) => ({
  kind: "api_key",
  betterAuthUserId: "ba1",
  credentialId: "k1",
  grantedScopes: ["admin.users.read"],
  access: { status: "active", membershipStatus: "active", permissions: ["admin.users.read"] },
  ...over,
});

let mod: typeof GuardModule;

beforeEach(async () => {
  for (const m of [
    resolveCaller,
    hasBearerCredential,
    checkTrustedOrigin,
    auditEvent,
    consumeToken,
  ])
    m.mockReset();
  hasBearerCredential.mockReturnValue(true);
  checkTrustedOrigin.mockReturnValue({ ok: true });
  mod = await import("@/lib/api-auth/v1-guard.server");
});
afterEach(() => vi.resetModules());

describe("requireApiPermission", () => {
  it("401 (with WWW-Authenticate) when no caller resolves", async () => {
    resolveCaller.mockResolvedValue(null);
    const res = await mod.requireApiPermission(makeReq(), "admin.users.read");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      expect(res.response.headers.get("WWW-Authenticate")).toContain("Bearer");
      expect(((await res.response.json()) as { code: string }).code).toBe("unauthorized");
    }
  });

  it("401 credential_revoked when the token's source key/client was revoked or rotated (review #43)", async () => {
    resolveCaller.mockResolvedValue({ ok: false, reason: "credential_revoked" });
    const res = await mod.requireApiPermission(makeReq(), "admin.users.read");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const body = (await res.response.json()) as { code: string; detail: string };
      expect(body.code).toBe("credential_revoked");
      expect(body.detail).toMatch(/revoked or rotated/);
      expect(res.response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    }
  });

  it("401 invalid_token (RFC 6750) when the JWT was minted for another resource (review #50/#53)", async () => {
    resolveCaller.mockResolvedValue({ ok: false, reason: "audience_mismatch" });
    const res = await mod.requireApiPermission(makeReq(), "admin.users.read");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      expect(((await res.response.json()) as { code: string }).code).toBe("invalid_token");
      expect(res.response.headers.get("WWW-Authenticate")).toContain(
        'error_description="audience mismatch"',
      );
    }
  });

  it("keeps the generic unauthorized code for every other rejection reason", async () => {
    for (const reason of ["invalid_credential", "path_disabled", "principal_banned"]) {
      resolveCaller.mockResolvedValue({ ok: false, reason });
      const res = await mod.requireApiPermission(makeReq(), "admin.users.read");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(((await res.response.json()) as { code: string }).code).toBe("unauthorized");
        // No hint distinguishes a bad credential from a disabled path or a ban.
        expect(res.response.headers.get("WWW-Authenticate")).toBe('Bearer realm="devresponse-api"');
      }
    }
  });

  it("403 when the caller's account/membership is not active", async () => {
    resolveCaller.mockResolvedValue(
      caller({ access: { status: "blocked", membershipStatus: "active", permissions: [] } }),
    );
    const res = await mod.requireApiPermission(makeReq(), "admin.users.read");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
  });

  it("403 + audits when the credential lacks the permission/scope", async () => {
    resolveCaller.mockResolvedValue(
      caller({
        grantedScopes: [],
        access: { status: "active", membershipStatus: "active", permissions: ["admin.users.read"] },
      }),
    );
    const res = await mod.requireApiPermission(makeReq(), "admin.users.read");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "api.access.denied", outcome: "denied" }),
    );
  });

  it("grants when permission ∈ access AND scope authorizes it", async () => {
    resolveCaller.mockResolvedValue(caller());
    const res = await mod.requireApiPermission(makeReq(), "admin.users.read");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.grant.caller.credentialId).toBe("k1");
  });

  it("enforces the origin guard only for cookie (non-bearer) callers", async () => {
    hasBearerCredential.mockReturnValue(false);
    checkTrustedOrigin.mockReturnValue({ ok: false, reason: "missing_origin" });
    const res = await mod.requireApiPermission(makeReq(), "admin.users.read");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
    expect(resolveCaller).not.toHaveBeenCalled(); // short-circuits before resolving
  });
});

describe("enforceApiRateLimit", () => {
  const grant = { caller: caller(), requestId: "req-1" } as unknown as GuardModule.ApiGrant;

  it("returns null when under the limit", async () => {
    consumeToken.mockReturnValue({ ok: true });
    expect(mod.enforceApiRateLimit("api.users.create", grant, makeReq())).toBeNull();
  });

  it("returns a 429 problem with Retry-After when over the limit", async () => {
    consumeToken.mockReturnValue({ ok: false, retryAfterSeconds: 7 });
    const res = mod.enforceApiRateLimit("api.users.create", grant, makeReq());
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("7");
  });
});
