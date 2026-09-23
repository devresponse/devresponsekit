import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * F-01 — A BEARER CREDENTIAL CANNOT REACH ITS OWNER'S CREDENTIALS IN ANOTHER
 * TENANT, AND CANNOT ROTATE ONE BROADER THAN ITSELF.
 *
 * The chain this pins closed (full review 2026-09-22, critical):
 *
 *   1. Alice, an org-A admin holding `admin.apikeys.manage`, mints a key on
 *      behalf of Bob with `account.read` + `account.apikeys.manage` — account
 *      scopes were "self-grantable", so every bound passed. (Closed at the
 *      mint: `tests/integration/on-behalf-mint-owner-reach-bound.test.ts`.)
 *   2. With that key, `GET /api/v1/me/api-keys` listed Bob's keys in EVERY
 *      org, including his org-B admin key.
 *   3. `POST /api/v1/me/api-keys/{orgB key}/rotate` checked only that the key
 *      was Bob's, re-minted it with its ORIGINAL org-B admin scopes, and handed
 *      Alice the plaintext. She now administered org B as Bob.
 *
 * Steps 2 and 3 are closed here, independently of step 1, because credentials
 * minted before the fix still exist: the bearer is confined to the org it acts
 * in, and a rotation must pass the same issuance rule as a mint.
 *
 * This drives the REAL routes over the REAL account guard; only the caller
 * resolver and the key repository are stubbed. Each refusal FAILS without the
 * fix, and the controls prove the fix is not a blanket denial.
 */

const resolveCaller = vi.fn();
const hasBearerCredential = vi.fn();
const auditEvent = vi.fn();
const listApiKeysForUser = vi.fn();
const createApiKey = vi.fn();
const getApiKeyById = vi.fn();
const revokeApiKey = vi.fn();
const rotateApiKey = vi.fn();

vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCaller: (...a: unknown[]) => resolveCaller(...a),
  hasBearerCredential: (...a: unknown[]) => hasBearerCredential(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  listApiKeysForUser: (...a: unknown[]) => listApiKeysForUser(...a),
  createApiKey: (...a: unknown[]) => createApiKey(...a),
  getApiKeyById: (...a: unknown[]) => getApiKeyById(...a),
  revokeApiKey: (...a: unknown[]) => revokeApiKey(...a),
  rotateApiKey: (...a: unknown[]) => rotateApiKey(...a),
}));
vi.mock("@/db/database", () => ({ db: {}, pgPool: {} }));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_IN_A = "11111111-1111-4111-8111-11111111111a";
const KEY_IN_B = "11111111-1111-4111-8111-11111111111b";

/** Bob, as the guard resolves him through a credential bound to org A. */
const BOB_IN_A = {
  appUserId: "app-bob",
  primaryEmail: "bob@x.com",
  status: "active",
  organizationId: ORG_A,
  membershipStatus: "active",
  preferredLocale: "en",
  // Bob is an admin in org B; in org A he holds only the membership baseline.
  permissions: ["shell.view"],
};

/** The on-behalf key Alice minted: authenticates as Bob, bound to org A. */
function bearerAsBob(grantedScopes: string[], access = BOB_IN_A) {
  return {
    kind: "api_key",
    betterAuthUserId: "ba-bob",
    access,
    grantedScopes,
    isBearer: true,
    credentialId: "key-alice-minted",
    boundOrganizationId: access.organizationId,
    impersonatorId: null,
  };
}

/** Bob himself, on an ordinary cookie session. */
function bobSession() {
  return {
    kind: "session",
    betterAuthUserId: "ba-bob",
    access: BOB_IN_A,
    grantedScopes: null,
    isBearer: false,
    credentialId: null,
    boundOrganizationId: null,
    impersonatorId: null,
  };
}

const KEYS: Record<string, { organization_id: string; scopes: string[] }> = {
  // Bob's org-B admin key — the prize.
  [KEY_IN_B]: { organization_id: ORG_B, scopes: ["admin.users.manage", "admin.roles.assign"] },
  // A key of Bob's inside org A carrying only account scopes.
  [KEY_IN_A]: { organization_id: ORG_A, scopes: ["account.read"] },
};

function req(path: string, method: string, body?: unknown, bearer = true): NextRequest {
  const url = new URL(`http://test.local${path}`);
  const headers = new Headers({ "content-type": "application/json" });
  if (bearer) headers.set("authorization", "Bearer drk_live_x");
  else headers.set("origin", "http://test.local");
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const ACCOUNT_KEY_SCOPES = ["account.read", "account.apikeys.manage"];

beforeEach(async () => {
  for (const m of [
    resolveCaller,
    hasBearerCredential,
    auditEvent,
    listApiKeysForUser,
    createApiKey,
    getApiKeyById,
    revokeApiKey,
    rotateApiKey,
  ]) {
    m.mockReset();
  }
  hasBearerCredential.mockImplementation((headers: Headers) => headers.has("authorization"));
  listApiKeysForUser.mockResolvedValue([]);
  getApiKeyById.mockImplementation(async (id: string) => {
    const key = KEYS[id];
    return key ? { id, app_user_id: "app-bob", status: "active", ...key } : undefined;
  });
  rotateApiKey.mockResolvedValue({
    id: "k-new",
    name: "n",
    key_prefix: "drk_live_y",
    scopes: [],
    expires_at: null,
    plaintext: "drk_live_y.SECRET",
  });
  revokeApiKey.mockResolvedValue(true);
  const rl = await import("@/lib/admin/rate-limit.server");
  rl.__resetRateLimitForTests();
});
afterEach(() => vi.resetModules());

describe("F-01: a bearer credential is confined to the tenant it acts in", () => {
  it("GET /api/v1/me/api-keys lists only the credential's own org", async () => {
    resolveCaller.mockResolvedValue(bearerAsBob(ACCOUNT_KEY_SCOPES));
    const { GET } = await import("@/app/api/v1/me/api-keys/route");

    const res = await GET(req("/api/v1/me/api-keys", "GET"));

    expect(res.status).toBe(200);
    expect(listApiKeysForUser).toHaveBeenCalledWith("app-bob", { organizationId: ORG_A });
  });

  it("POST …/{org-B key}/rotate is a 404 — no secret for another tenant", async () => {
    resolveCaller.mockResolvedValue(bearerAsBob(ACCOUNT_KEY_SCOPES));
    const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");

    const res = await POST(req(`/api/v1/me/api-keys/${KEY_IN_B}/rotate`, "POST"), params(KEY_IN_B));

    expect(res.status).toBe(404);
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it("DELETE …/{org-B key} is a 404 — no revoking another tenant's key", async () => {
    resolveCaller.mockResolvedValue(bearerAsBob(ACCOUNT_KEY_SCOPES));
    const { DELETE } = await import("@/app/api/v1/me/api-keys/[id]/route");

    const res = await DELETE(req(`/api/v1/me/api-keys/${KEY_IN_B}`, "DELETE"), params(KEY_IN_B));

    expect(res.status).toBe(404);
    expect(revokeApiKey).not.toHaveBeenCalled();
  });

  it("control: DELETE of a key INSIDE the credential's org still works (200)", async () => {
    resolveCaller.mockResolvedValue(bearerAsBob(ACCOUNT_KEY_SCOPES));
    const { DELETE } = await import("@/app/api/v1/me/api-keys/[id]/route");

    const res = await DELETE(req(`/api/v1/me/api-keys/${KEY_IN_A}`, "DELETE"), params(KEY_IN_A));

    expect(res.status).toBe(200);
    expect(revokeApiKey).toHaveBeenCalledWith(KEY_IN_A, "app-bob", "self_revoked");
  });

  it.each(["api_key", "jwt"])("a %s caller is confined the same way", async (kind) => {
    resolveCaller.mockResolvedValue({ ...bearerAsBob(ACCOUNT_KEY_SCOPES), kind });
    const list = await import("@/app/api/v1/me/api-keys/route");
    const one = await import("@/app/api/v1/me/api-keys/[id]/route");
    const rotate = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");

    await list.GET(req("/api/v1/me/api-keys", "GET"));
    const del = await one.DELETE(
      req(`/api/v1/me/api-keys/${KEY_IN_B}`, "DELETE"),
      params(KEY_IN_B),
    );
    const rot = await rotate.POST(
      req(`/api/v1/me/api-keys/${KEY_IN_B}/rotate`, "POST"),
      params(KEY_IN_B),
    );

    expect(listApiKeysForUser).toHaveBeenCalledWith("app-bob", { organizationId: ORG_A });
    expect([del.status, rot.status]).toEqual([404, 404]);
    expect(revokeApiKey).not.toHaveBeenCalled();
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it("an ORG-LESS key of the owner is outside every bearer's tenant (404)", async () => {
    const ORGLESS = "11111111-1111-4111-8111-11111111110c";
    KEYS[ORGLESS] = { organization_id: null as unknown as string, scopes: ["account.read"] };
    try {
      resolveCaller.mockResolvedValue(bearerAsBob(ACCOUNT_KEY_SCOPES));
      const { DELETE } = await import("@/app/api/v1/me/api-keys/[id]/route");
      const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");

      const del = await DELETE(req(`/api/v1/me/api-keys/${ORGLESS}`, "DELETE"), params(ORGLESS));
      const rot = await POST(req(`/api/v1/me/api-keys/${ORGLESS}/rotate`, "POST"), params(ORGLESS));

      expect([del.status, rot.status]).toEqual([404, 404]);
    } finally {
      delete KEYS[ORGLESS];
    }
  });

  it("a bearer that resolved NO org reaches nothing (fail closed)", async () => {
    // Defensive: the guard refuses a caller without an active membership, so
    // this shape should never pass it — but if it did, confinement must not
    // degrade to "unconfined".
    const { tenantConfinement, isWithinTenant } = await import("@/lib/account/guard.server");
    const confinement = tenantConfinement({
      callerKind: "api_key",
      impersonatorId: null,
      access: { ...BOB_IN_A, organizationId: null } as never,
    });
    expect(confinement).toEqual({ organizationId: null });
    expect(isWithinTenant(ORG_A, confinement)).toBe(false);
    expect(isWithinTenant(null, confinement)).toBe(false);
  });

  it("an unrecognised caller kind is confined, never account-wide", async () => {
    const { tenantConfinement } = await import("@/lib/account/guard.server");
    expect(
      tenantConfinement({
        callerKind: undefined as never,
        impersonatorId: null,
        access: BOB_IN_A as never,
      }),
    ).toEqual({ organizationId: ORG_A });
  });
});

describe("F-01: a rotation is an issuance — a narrow credential cannot rotate a broader key", () => {
  it("refuses (403 invalid_scope) rotating a key in the SAME org carrying scopes the bearer lacks", async () => {
    // Same-tenant variant: confinement alone would not stop it. The org-A key
    // carries `admin.*` scopes the calling credential (account.* only) lacks.
    KEYS[KEY_IN_A] = { organization_id: ORG_A, scopes: ["admin.users.manage"] };
    try {
      resolveCaller.mockResolvedValue(
        bearerAsBob(ACCOUNT_KEY_SCOPES, {
          ...BOB_IN_A,
          permissions: ["shell.view", "admin.users.manage"],
        }),
      );
      const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");

      const res = await POST(
        req(`/api/v1/me/api-keys/${KEY_IN_A}/rotate`, "POST"),
        params(KEY_IN_A),
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string; ungrantableScopes: string[] };
      expect(body.ungrantableScopes).toEqual(["admin.users.manage"]);
      expect(rotateApiKey).not.toHaveBeenCalled();
      expect(auditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "api_key.rotate_denied",
          reason: "scope_not_grantable",
        }),
      );
    } finally {
      KEYS[KEY_IN_A] = { organization_id: ORG_A, scopes: ["account.read"] };
    }
  });

  it("an INACTIVE key answers 409, not a scope denial (and writes no denial row)", async () => {
    KEYS[KEY_IN_A] = { organization_id: ORG_A, scopes: ["admin.users.manage"] };
    getApiKeyById.mockImplementation(async (id: string) =>
      id === KEY_IN_A
        ? { id, app_user_id: "app-bob", status: "revoked", ...KEYS[KEY_IN_A] }
        : undefined,
    );
    try {
      resolveCaller.mockResolvedValue(bearerAsBob(ACCOUNT_KEY_SCOPES));
      const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");

      const res = await POST(
        req(`/api/v1/me/api-keys/${KEY_IN_A}/rotate`, "POST"),
        params(KEY_IN_A),
      );

      expect(res.status).toBe(409);
      expect(auditEvent).not.toHaveBeenCalled();
    } finally {
      KEYS[KEY_IN_A] = { organization_id: ORG_A, scopes: ["account.read"] };
    }
  });

  it("control: rotates a key in its own org whose scopes it carries (201)", async () => {
    resolveCaller.mockResolvedValue(bearerAsBob(ACCOUNT_KEY_SCOPES));
    const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");

    const res = await POST(req(`/api/v1/me/api-keys/${KEY_IN_A}/rotate`, "POST"), params(KEY_IN_A));

    expect(res.status).toBe(201);
    expect(rotateApiKey).toHaveBeenCalledWith(KEY_IN_A, "app-bob");
  });
});

describe("F-01 controls: the owner on an ordinary session keeps account-wide reach", () => {
  it("lists every key they own (unconfined)", async () => {
    resolveCaller.mockResolvedValue(bobSession());
    const { GET } = await import("@/app/api/v1/me/api-keys/route");

    const res = await GET(req("/api/v1/me/api-keys", "GET", undefined, false));

    expect(res.status).toBe(200);
    expect(listApiKeysForUser).toHaveBeenCalledWith("app-bob");
  });

  it("rotates their own admin key in another org, whatever their ACTIVE org grants", async () => {
    // Bob's active org is A (baseline only); the key is his org-B admin key.
    // He is the owner with full authority there — the successor conveys
    // nothing he does not hold — so the bearer scope bound must not apply.
    resolveCaller.mockResolvedValue(bobSession());
    const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");

    const res = await POST(
      req(`/api/v1/me/api-keys/${KEY_IN_B}/rotate`, "POST", undefined, false),
      params(KEY_IN_B),
    );

    expect(res.status).toBe(201);
    expect(rotateApiKey).toHaveBeenCalledWith(KEY_IN_B, "app-bob");
  });

  it("revokes their own key in another org", async () => {
    resolveCaller.mockResolvedValue(bobSession());
    const { DELETE } = await import("@/app/api/v1/me/api-keys/[id]/route");

    const res = await DELETE(
      req(`/api/v1/me/api-keys/${KEY_IN_B}`, "DELETE", undefined, false),
      params(KEY_IN_B),
    );

    expect(res.status).toBe(200);
    expect(revokeApiKey).toHaveBeenCalledWith(KEY_IN_B, "app-bob", "self_revoked");
  });
});
