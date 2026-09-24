import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import { USER_NAME_MAX_LENGTH } from "@/lib/user-name";

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
const requireApiAccount = vi.fn();
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
// The v1 self-service routes gate on `requireApiAccount` — the problem+json
// rendering of the same account decision (review #45).
vi.mock("@/lib/account/guard.server", () => ({
  requireApiAccount: (...a: unknown[]) => requireApiAccount(...a),
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
    requireApiAccount,
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

  it("answers an uncached problem+json 500 when the keys cannot be loaded (F-22, review #50)", async () => {
    getJwks.mockRejectedValue(new Error("API_JWT_PREVIOUS_PRIVATE_KEY: secret-looking detail"));
    const { GET } = await import("@/app/api/v1/jwks.json/route");
    const res = await GET(req("/api/v1/jwks.json"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: "internal_error", status: 500 });
    // The cause is logged, never echoed to the client.
    expect(text).not.toContain("secret-looking detail");
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

  it("answers a problem+json 500, not a credential error, when the signing key fails (F-22)", async () => {
    verifyClientCredentials.mockResolvedValue({
      betterAuthUserId: "ba1",
      scopes: ["admin.users.read"],
      organizationId: null,
    });
    mintAccessToken.mockRejectedValue(new Error("API_JWT_PRIVATE_KEY: secret-looking detail"));
    const POST = await load();
    const res = await POST(
      req("/api/v1/auth/token", {
        method: "POST",
        body: { grant_type: "client_credentials", client_id: "drkc_x", client_secret: "drkcsec_y" },
      }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: "internal_error" });
    expect(text).not.toContain("secret-looking detail");
    // Nothing was issued, so nothing is audited as issued.
    expect(auditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "token.issued" }),
    );
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
    // limiter's DB-error fallback: the first bucket consulted is the per-IP
    // one, and its refusal never reaches the global floor (F-18).
    expect(consumeToken.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/^api\.token:(?:ip:|anon$)/),
    ]);
  });
});

describe("GET /api/v1/me", () => {
  it("403 (guard response) when the account guard denies", async () => {
    const { NextResponse } = await import("next/server");
    requireApiAccount.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ e: 1 }, { status: 403 }),
    });
    const { GET } = await import("@/app/api/v1/me/route");
    const res = await GET(req("/api/v1/me"));
    expect(res.status).toBe(403);
  });

  it("returns identity + effectiveScopes (scopes ∩ permissions)", async () => {
    requireApiAccount.mockResolvedValue({
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

  it("review #46: expands `prefix.*` wildcard grants the way the guards do", async () => {
    // A credential granted `admin.users.*` IS authorized for every
    // `admin.users.<x>` by `scopesAuthorize` — which is what every guard
    // calls. Introspection used a literal `.includes`, so this caller was
    // told it could do NOTHING while the API served its calls: the worst
    // possible answer from an endpoint whose whole job is telling a client
    // what it may attempt.
    requireApiAccount.mockResolvedValue({
      ok: true,
      actor: {
        betterAuthUserId: "ba1",
        appUserId: "u1",
        callerKind: "api_key",
        credentialId: "k1",
        grantedScopes: ["admin.users.*"],
        access: {
          primaryEmail: "a@x.com",
          status: "active",
          organizationId: "o1",
          preferredLocale: "en",
          permissions: ["admin.users.read", "admin.users.manage", "admin.orgs.read"],
        },
      },
    });
    const { GET } = await import("@/app/api/v1/me/route");
    const res = await GET(req("/api/v1/me"));
    const body = (await res.json()) as { effectiveScopes: string[] };
    expect(body.effectiveScopes).toEqual(["admin.users.read", "admin.users.manage"]);
  });

  it("review #46: a cookie session (null scopes) reports its full permission set", async () => {
    requireApiAccount.mockResolvedValue({
      ok: true,
      actor: {
        betterAuthUserId: "ba1",
        appUserId: "u1",
        callerKind: "session",
        credentialId: null,
        grantedScopes: null,
        access: {
          primaryEmail: "a@x.com",
          status: "active",
          organizationId: "o1",
          preferredLocale: "en",
          permissions: ["admin.users.read", "shell.view"],
        },
      },
    });
    const { GET } = await import("@/app/api/v1/me/route");
    const body = (await (await GET(req("/api/v1/me"))).json()) as { effectiveScopes: string[] };
    expect(body.effectiveScopes).toEqual(["admin.users.read", "shell.view"]);
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

  // F-21: the v1 create shares the name rule (`user-name.ts`) with every other
  // writer, so a caller's line break, bidi control or oversized name is a 400
  // before anything is written, not a changed name.
  it.each([
    ["a line break", "Ann\nLee"],
    ["a bidi override", "Ann \u202egnp.exe"],
    ["a name over the bound", "x".repeat(USER_NAME_MAX_LENGTH + 1)],
    ["a blank name", "   "],
  ])("F-21: POST 400 on %s, before any write", async (_label, name) => {
    requireApiPermission.mockResolvedValue(grant);
    const { POST } = await import("@/app/api/v1/users/route");
    const res = await POST(
      req("/api/v1/users", {
        method: "POST",
        body: { email: "new@x.com", password: "password123", name },
      }),
    );
    expect(res.status).toBe(400);
    expect(createBetterAuthUser).not.toHaveBeenCalled();
  });

  it("F-21: POST creates the user under the canonical spelling of its name", async () => {
    requireApiPermission.mockResolvedValue(grant);
    dbState.takeFirst = undefined;
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
        body: { email: "new@x.com", password: "password123", name: "  Ada \u00a0 Lovelace " },
      }),
    );
    expect(res.status).toBe(201);
    expect(createBetterAuthUser).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ada Lovelace" }),
    );
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
    // F-03: an unbound superadmin session vouches for the address.
    expect(createBetterAuthUser).toHaveBeenCalledWith(
      expect.objectContaining({ emailUnproven: false }),
    );
    // F-13: a trusted server call; no caller credentials reach the wrapper.
    expect(createBetterAuthUser.mock.calls[0]).toHaveLength(1);
  });

  it("F-03: a superuser-owned key BOUND to one org does not vouch (MACHINE-2)", async () => {
    requireApiPermission.mockResolvedValue({
      ok: true,
      grant: {
        caller: {
          betterAuthUserId: "ba1",
          access: {
            permissions: ["admin.users.create", "superuser"],
            organizationId: "o1",
            orgBound: true,
          },
        },
        requestId: "r1",
      },
    });
    dbState.takeFirst = undefined;
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
    expect(createBetterAuthUser).toHaveBeenCalledWith(
      expect.objectContaining({ emailUnproven: true }),
    );
  });

  it("F-03: a creator WITHOUT cross-org reach creates an identity with no mailbox proof", async () => {
    requireApiPermission.mockResolvedValue({
      ok: true,
      grant: {
        caller: {
          betterAuthUserId: "ba1",
          access: { permissions: ["admin.users.create"], organizationId: "o1" },
        },
        requestId: "r1",
      },
    });
    dbState.takeFirst = undefined;
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
    expect(createBetterAuthUser).toHaveBeenCalledWith(
      expect.objectContaining({ emailUnproven: true }),
    );
  });

  // Every API key and JWT resolves org-bound (MACHINE-2: resolveCaller always
  // passes a bound org, and getUserAccessContext then sets `orgBound`), so a
  // bearer caller can never pass this gate. The one caller that can is a
  // superadmin's COOKIE session, which the v1 guard also admits.
  describe('F-13: `role: "admin"` needs cross-org reach, as on the admin twin', () => {
    async function createAdmin(access: Record<string, unknown>) {
      requireApiPermission.mockResolvedValue({
        ok: true,
        grant: { caller: { betterAuthUserId: "ba1", access }, requestId: "r1" },
      });
      dbState.takeFirst = undefined;
      createBetterAuthUser.mockResolvedValue({ user: { id: "ba-new" } });
      dbState.takeFirstOrThrow = { id: "u-new", primary_email: "new@x.com", status: "active" };
      const { POST } = await import("@/app/api/v1/users/route");
      return POST(
        req("/api/v1/users", {
          method: "POST",
          body: { email: "new@x.com", password: "password123", role: "admin" },
        }),
      );
    }

    it("an org admin is refused with 403 and creates nothing", async () => {
      const res = await createAdmin({ permissions: ["admin.users.create"], organizationId: "o1" });
      expect(res.status).toBe(403);
      expect(createBetterAuthUser).not.toHaveBeenCalled();
    });

    it("a superuser-owned key or JWT is refused too: every bearer credential is org-bound (MACHINE-2)", async () => {
      const res = await createAdmin({
        permissions: ["admin.users.create", "superuser"],
        organizationId: "o1",
        orgBound: true,
      });
      expect(res.status).toBe(403);
      expect(createBetterAuthUser).not.toHaveBeenCalled();
    });

    it("a superadmin's cookie session (not org-bound) creates it", async () => {
      const res = await createAdmin({
        permissions: ["superuser"],
        organizationId: "o1",
        orgBound: false,
      });
      expect(res.status).toBe(201);
      expect(createBetterAuthUser).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }));
    });
  });

  /*
   * F-30: the `app_users` check is a courtesy (no unique key on the email), so
   * an address Better Auth already holds, with no `app_users` row or through a
   * concurrent create, fails INSIDE `createBetterAuthUser`. That is the 409
   * this route documents, not a 502. Every failure row names NO `app_users` row
   * (`app_user_id` is a foreign key; the nil UUID it used to name failed it).
   */
  const postNew = async (email: string) => {
    requireApiPermission.mockResolvedValue(grant);
    dbState.takeFirst = undefined; // the up-front email check passes
    const { POST } = await import("@/app/api/v1/users/route");
    return POST(req("/api/v1/users", { method: "POST", body: { email, password: "password123" } }));
  };

  it.each([
    [
      "the admin plugin's refusal",
      Object.assign(new Error("User already exists. Use another email."), {
        body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
      }),
    ],
    [
      "the unique violation a concurrent create's loser gets",
      Object.assign(new Error("duplicate key"), { code: "23505", constraint: "user_email_key" }),
    ],
  ])(
    "POST 409 + create_failed naming no user when Better Auth holds the address: %s (F-30)",
    async (_l, err) => {
      createBetterAuthUser.mockRejectedValue(err);
      const res = await postNew("held@x.com");
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "conflict" });
      expect(auditUserAction).toHaveBeenCalledWith(
        "admin.user.create_failed",
        "error",
        expect.objectContaining({
          appUserId: null,
          email: "held@x.com",
          reason: "auth_user_exists",
          metadata: expect.objectContaining({ via: "api.v1" }),
        }),
      );
    },
  );

  it("POST 502 + create_failed naming no user when Better Auth fails for another reason (F-30)", async () => {
    createBetterAuthUser.mockRejectedValue(new Error("identity store unreachable"));
    const res = await postNew("x@x.com");
    expect(res.status).toBe(502);
    expect(auditUserAction).toHaveBeenCalledWith(
      "admin.user.create_failed",
      "error",
      expect.objectContaining({ appUserId: null, reason: "auth_create_user_failed" }),
    );
  });

  it.each([
    ["a user with no id", { user: { email: "x@x.com" } }, ["user"]],
    ["nothing", null, []],
  ])(
    "POST 502 + create_failed naming no user when Better Auth returns %s (F-30)",
    async (_l, returned, returnedKeys) => {
      createBetterAuthUser.mockResolvedValue(returned);
      const res = await postNew("x@x.com");
      expect(res.status).toBe(502);
      expect(auditUserAction).toHaveBeenCalledTimes(1);
      expect(auditUserAction).toHaveBeenCalledWith(
        "admin.user.create_failed",
        "error",
        expect.objectContaining({
          appUserId: null,
          email: "x@x.com",
          reason: "auth_create_no_id",
          metadata: { returnedKeys, via: "api.v1" },
        }),
      );
    },
  );

  it.each([
    ["a connection failure", new Error("connection reset")],
    // The one unique key on `app_users` is the id Better Auth just minted, so
    // a 23505 here is not an email race: it is no longer mapped to 409.
    ["a unique violation", Object.assign(new Error("duplicate key"), { code: "23505" })],
  ])(
    "POST 502 + create_failed naming no user when the insert fails: %s (OPS-OBS-1, F-30)",
    async (_l, err) => {
      createBetterAuthUser.mockResolvedValue({ user: { id: "ba-x" } });
      dbState.takeFirstOrThrow = err;
      const res = await postNew("x@x.com");
      expect(res.status).toBe(502);
      expect(auditUserAction).toHaveBeenCalledWith(
        "admin.user.create_failed",
        "error",
        expect.objectContaining({
          appUserId: null,
          reason: "db_insert_failed",
          metadata: { betterAuthUserId: "ba-x", via: "api.v1" },
        }),
      );
    },
  );
});
