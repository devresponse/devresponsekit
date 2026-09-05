import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * Integration tests for representative `/api/v1` route handlers. The auth
 * guards and persistence layers are mocked; these exercise the handler
 * contracts — problem+json errors, the OAuth2 token flow, account/admin
 * gating, and the list/create envelopes.
 */
const env = vi.hoisted(() => ({
  API_JWT_ENABLED: true,
  BETTER_AUTH_URL: "https://app.example.com",
  API_JWT_AUDIENCE: "devresponse-api",
  API_JWT_ACCESS_TTL_SECONDS: 900,
  API_KEYS_ENABLED: true,
  API_JWT_PRIVATE_KEY: "{}",
}));
const auditEvent = vi.fn();
const getUserAccessContext = vi.fn();
const consumeToken = vi.fn();
const verifyClientCredentials = vi.fn();
const verifyApiKey = vi.fn();
const isBetterAuthUserBanned = vi.fn();
const mintAccessToken = vi.fn();
const getJwks = vi.fn();
const requireApiPermission = vi.fn();
const enforceApiRateLimit = vi.fn();
const requireAccountUser = vi.fn();
const createBetterAuthUser = vi.fn();
const auditUserAction = vi.fn();

const dbState = vi.hoisted(() => ({
  execute: [] as unknown[],
  takeFirst: undefined as unknown,
  takeFirstOrThrow: undefined as unknown,
}));
function chain(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "execute") return () => Promise.resolve(dbState.execute);
      if (prop === "executeTakeFirst") return () => Promise.resolve(dbState.takeFirst);
      if (prop === "executeTakeFirstOrThrow")
        return () =>
          dbState.takeFirstOrThrow instanceof Error
            ? Promise.reject(dbState.takeFirstOrThrow)
            : Promise.resolve(dbState.takeFirstOrThrow);
      if (prop === "then") return undefined;
      return (cb?: unknown) => {
        if (typeof cb === "function")
          try {
            (cb as (eb: unknown) => unknown)(
              new Proxy(() => ({}), { get: () => () => ({}), apply: () => ({}) }),
            );
          } catch {
            /* eb stub */
          }
        return chain();
      };
    },
    apply() {
      return chain();
    },
  });
}

vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => getUserAccessContext(id) };
});
vi.mock("@/lib/admin/rate-limit.server", () => ({
  consumeToken: (...a: unknown[]) => consumeToken(...a),
  rateLimitKey: (s: string, id: string) => `${s}:${id}`,
  DEFAULT_ADMIN_MUTATION_LIMIT: {},
}));
// The token route's pre-auth floors consume from the SHARED bucket (review
// #98). Without this mock the real module would hit the `@/db/database` stub
// below, throw inside its SQL, and only reach `consumeToken` through the
// production DB-error FALLBACK — so the 429 case would pass by way of the
// fail-soft path rather than the contract. Route it through the same
// recording spy the sibling token suites use.
vi.mock("@/lib/admin/rate-limit-shared.server", () => ({
  consumeSharedToken: async (...a: unknown[]) => consumeToken(...a),
}));
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  verifyClientCredentials: (...a: unknown[]) => verifyClientCredentials(...a),
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  verifyApiKey: (...a: unknown[]) => verifyApiKey(...a),
}));
vi.mock("@/lib/api-auth/ban-status.server", () => ({
  isBetterAuthUserBanned: (...a: unknown[]) => isBetterAuthUserBanned(...a),
}));
vi.mock("@/lib/api-auth/jwt.server", () => ({
  mintAccessToken: (...a: unknown[]) => mintAccessToken(...a),
  getJwks: () => getJwks(),
}));
vi.mock("@/lib/api-auth/v1-guard.server", () => ({
  requireApiPermission: (...a: unknown[]) => requireApiPermission(...a),
  enforceApiRateLimit: (...a: unknown[]) => enforceApiRateLimit(...a),
}));
vi.mock("@/lib/account/guard.server", () => ({
  requireAccountUser: (...a: unknown[]) => requireAccountUser(...a),
}));
vi.mock("@/lib/admin/auth-admin.server", () => ({
  createBetterAuthUser: (...a: unknown[]) => createBetterAuthUser(...a),
}));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditUserAction: (...a: unknown[]) => auditUserAction(...a),
}));
vi.mock("@/db/database", () => ({ db: { selectFrom: () => chain(), insertInto: () => chain() } }));

function req(
  path: string,
  init?: { method?: string; body?: unknown; contentType?: string },
): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": init?.contentType ?? "application/json" }),
    json: async () => init?.body,
    text: async () => (typeof init?.body === "string" ? init.body : ""),
  } as unknown as NextRequest;
}

const ACTIVE = { status: "active", membershipStatus: "active", appUserId: "u1", permissions: [] };

beforeEach(() => {
  env.API_JWT_ENABLED = true;
  env.API_KEYS_ENABLED = true;
  env.API_JWT_PRIVATE_KEY = "{}";
  dbState.execute = [];
  dbState.takeFirst = undefined;
  dbState.takeFirstOrThrow = undefined;
  for (const m of [
    auditEvent,
    getUserAccessContext,
    consumeToken,
    verifyClientCredentials,
    verifyApiKey,
    isBetterAuthUserBanned,
    mintAccessToken,
    getJwks,
    requireApiPermission,
    enforceApiRateLimit,
    requireAccountUser,
    createBetterAuthUser,
    auditUserAction,
  ])
    m.mockReset();
  consumeToken.mockReturnValue({ ok: true });
  getUserAccessContext.mockResolvedValue(ACTIVE);
  enforceApiRateLimit.mockReturnValue(null);
  isBetterAuthUserBanned.mockResolvedValue(false);
});
afterEach(() => vi.resetModules());

describe("GET /api/v1/openapi.json", () => {
  it("returns an OpenAPI 3.1 document with paths", async () => {
    const { GET } = await import("@/app/api/v1/openapi.json/route");
    const res = await GET(req("/api/v1/openapi.json"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toMatch(/^3\./);
    expect(Object.keys(body.paths).length).toBeGreaterThan(0);
  });
});

describe("GET /api/v1/jwks.json", () => {
  it("returns an empty key set when JWT is disabled", async () => {
    env.API_JWT_ENABLED = false;
    const { GET } = await import("@/app/api/v1/jwks.json/route");
    const res = await GET(req("/api/v1/jwks.json"));
    expect(res.status).toBe(200);
    expect((await res.json()) as { keys: unknown[] }).toEqual({ keys: [] });
  });

  it("publishes the JWKS when enabled", async () => {
    getJwks.mockResolvedValue({ keys: [{ kty: "OKP", crv: "Ed25519", x: "abc", kid: "k1" }] });
    const { GET } = await import("@/app/api/v1/jwks.json/route");
    const res = await GET(req("/api/v1/jwks.json"));
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(1);
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });
});

describe("POST /api/v1/auth/token", () => {
  async function load() {
    return (await import("@/app/api/v1/auth/token/route")).POST;
  }

  it("400 unsupported_grant_type when JWT is disabled", async () => {
    env.API_JWT_ENABLED = false;
    const POST = await load();
    const res = await POST(
      req("/api/v1/auth/token", { method: "POST", body: { grant_type: "api_key" } }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("mints a token for valid client_credentials", async () => {
    verifyClientCredentials.mockResolvedValue({
      betterAuthUserId: "ba1",
      scopes: ["admin.users.read"],
      organizationId: null,
    });
    mintAccessToken.mockResolvedValue({
      token: "eyJ.signed",
      expiresInSeconds: 900,
      scopes: ["admin.users.read"],
    });
    const POST = await load();
    const res = await POST(
      req("/api/v1/auth/token", {
        method: "POST",
        body: { grant_type: "client_credentials", client_id: "drkc_x", client_secret: "drkcsec_y" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body).toMatchObject({
      access_token: "eyJ.signed",
      token_type: "Bearer",
      expires_in: 900,
    });
    expect(auditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "token.issued" }));
  });

  it("401 invalid_client on a bad client secret", async () => {
    verifyClientCredentials.mockResolvedValue(null);
    const POST = await load();
    const res = await POST(
      req("/api/v1/auth/token", {
        method: "POST",
        body: { grant_type: "client_credentials", client_id: "drkc_x", client_secret: "wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401 invalid_client + token.denied audit when the principal is banned (MAPI-2)", async () => {
    verifyClientCredentials.mockResolvedValue({
      betterAuthUserId: "ba-banned",
      scopes: ["admin.users.read"],
      organizationId: null,
    });
    isBetterAuthUserBanned.mockResolvedValue(true);
    const POST = await load();
    const res = await POST(
      req("/api/v1/auth/token", {
        method: "POST",
        body: { grant_type: "client_credentials", client_id: "drkc_x", client_secret: "drkcsec_y" },
      }),
    );
    expect(res.status).toBe(401);
    // The banned principal never gets a token.
    expect(mintAccessToken).not.toHaveBeenCalled();
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "token.denied",
        outcome: "denied",
        reason: "principal_banned",
      }),
    );
    expect(auditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "token.issued" }),
    );
  });

  it("400 on an unknown grant type", async () => {
    const POST = await load();
    const res = await POST(
      req("/api/v1/auth/token", { method: "POST", body: { grant_type: "password" } }),
    );
    expect(res.status).toBe(400);
  });

  it("429 when rate-limited", async () => {
    consumeToken.mockReturnValue({ ok: false });
    const POST = await load();
    const res = await POST(
      req("/api/v1/auth/token", { method: "POST", body: { grant_type: "api_key" } }),
    );
    expect(res.status).toBe(429);
    // The deny came from the shared-floor spy (mocked above), not the
    // limiter's DB-error fallback: the first bucket consulted is the global one.
    expect(consumeToken.mock.calls[0]?.[0]).toBe("api.token:__global__");
  });
});

describe("GET /api/v1/me", () => {
  it("403 (guard response) when the account guard denies", async () => {
    const { NextResponse } = await import("next/server");
    requireAccountUser.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ e: 1 }, { status: 403 }),
    });
    const { GET } = await import("@/app/api/v1/me/route");
    const res = await GET(req("/api/v1/me"));
    expect(res.status).toBe(403);
  });

  it("returns identity + effectiveScopes (scopes ∩ permissions)", async () => {
    requireAccountUser.mockResolvedValue({
      ok: true,
      actor: {
        betterAuthUserId: "ba1",
        appUserId: "u1",
        callerKind: "api_key",
        credentialId: "k1",
        grantedScopes: ["admin.users.read", "admin.orgs.read"],
        access: {
          primaryEmail: "a@x.com",
          status: "active",
          organizationId: "o1",
          preferredLocale: "en",
          permissions: ["admin.users.read"],
        },
      },
    });
    const { GET } = await import("@/app/api/v1/me/route");
    const res = await GET(req("/api/v1/me"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      effectiveScopes: string[];
      authentication: { kind: string };
    };
    // intersection of grantedScopes with permissions
    expect(body.effectiveScopes).toEqual(["admin.users.read"]);
    expect(body.authentication.kind).toBe("api_key");
  });
});

describe("/api/v1/users", () => {
  // `access` carries the `superuser` marker so the list is unscoped
  // (global behavior) — the org-scoping path is covered by its own test.
  const grant = {
    ok: true,
    grant: {
      caller: {
        betterAuthUserId: "ba1",
        access: { permissions: ["superuser"], organizationId: "o1" },
      },
      requestId: "r1",
    },
  };

  it("GET returns the standard list envelope", async () => {
    requireApiPermission.mockResolvedValue(grant);
    dbState.execute = [{ id: "u1", primary_email: "a@x.com" }];
    dbState.takeFirst = { total: "1" };
    const { GET } = await import("@/app/api/v1/users/route");
    const res = await GET(req("/api/v1/users"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("GET returns the guard's response when unauthorized", async () => {
    const { NextResponse } = await import("next/server");
    requireApiPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ e: 1 }, { status: 401 }),
    });
    const { GET } = await import("@/app/api/v1/users/route");
    const res = await GET(req("/api/v1/users"));
    expect(res.status).toBe(401);
  });

  it("POST 400 on an invalid body (strict schema)", async () => {
    requireApiPermission.mockResolvedValue(grant);
    const { POST } = await import("@/app/api/v1/users/route");
    const res = await POST(
      req("/api/v1/users", { method: "POST", body: { email: "not-an-email" } }),
    );
    expect(res.status).toBe(400);
  });

  it("POST 409 when the email already exists", async () => {
    requireApiPermission.mockResolvedValue(grant);
    dbState.takeFirst = { id: "existing" };
    const { POST } = await import("@/app/api/v1/users/route");
    const res = await POST(
      req("/api/v1/users", {
        method: "POST",
        body: { email: "dupe@x.com", password: "password123" },
      }),
    );
    expect(res.status).toBe(409);
  });

  it("POST 201 creates the user and audits", async () => {
    requireApiPermission.mockResolvedValue(grant);
    dbState.takeFirst = undefined; // no existing user
    createBetterAuthUser.mockResolvedValue({ user: { id: "ba-new" } });
    dbState.takeFirstOrThrow = {
      id: "u-new",
      primary_email: "new@x.com",
      status: "pending_approval",
    };
    const { POST } = await import("@/app/api/v1/users/route");
    const res = await POST(
      req("/api/v1/users", {
        method: "POST",
        body: { email: "new@x.com", password: "password123" },
      }),
    );
    expect(res.status).toBe(201);
    expect(auditUserAction).toHaveBeenCalledWith(
      "admin.user.created",
      "success",
      expect.objectContaining({ metadata: expect.objectContaining({ via: "api.v1" }) }),
    );
  });

  it("POST 409 + create_failed audit when the insert loses the unique race (OPS-OBS-1)", async () => {
    requireApiPermission.mockResolvedValue(grant);
    dbState.takeFirst = undefined; // up-front email check passes
    createBetterAuthUser.mockResolvedValue({ user: { id: "ba-race" } });
    dbState.takeFirstOrThrow = Object.assign(new Error("duplicate key"), { code: "23505" });
    const { POST } = await import("@/app/api/v1/users/route");
    const res = await POST(
      req("/api/v1/users", {
        method: "POST",
        body: { email: "race@x.com", password: "password123" },
      }),
    );
    expect(res.status).toBe(409);
    expect(auditUserAction).toHaveBeenCalledWith(
      "admin.user.create_failed",
      "error",
      expect.objectContaining({ reason: "email_taken_race" }),
    );
  });

  it("POST 502 + create_failed audit when the insert fails for another reason (OPS-OBS-1)", async () => {
    requireApiPermission.mockResolvedValue(grant);
    dbState.takeFirst = undefined;
    createBetterAuthUser.mockResolvedValue({ user: { id: "ba-x" } });
    dbState.takeFirstOrThrow = new Error("connection reset");
    const { POST } = await import("@/app/api/v1/users/route");
    const res = await POST(
      req("/api/v1/users", {
        method: "POST",
        body: { email: "x@x.com", password: "password123" },
      }),
    );
    expect(res.status).toBe(502);
    expect(auditUserAction).toHaveBeenCalledWith(
      "admin.user.create_failed",
      "error",
      expect.objectContaining({ reason: "db_insert_failed" }),
    );
  });
});
