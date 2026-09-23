import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * IMP-1 — AN IMPERSONATED SESSION CANNOT ISSUE, ROTATE OR DESTROY ANOTHER
 * PERSON'S CREDENTIALS, AND CANNOT ENUMERATE THEIR OTHER TENANTS' KEYS.
 *
 * The vulnerability this pins closed: the self-service credential routes never
 * looked at `impersonatorId`, even though the account guard already surfaced
 * it. While impersonating, ownership is not a barrier — the session simply IS
 * the target — so an administrator could:
 *
 *   1. `GET /api/v1/me/api-keys` and get the borrowed user's keys in EVERY
 *      tenant they belong to (`listApiKeysForUser` filters on `app_user_id`
 *      alone), which is the enumeration step;
 *   2. `POST …/[id]/rotate` one of them — `rotateApiKey` re-mints with the
 *      EXISTING `organization_id` and the ORIGINAL scopes and returns the new
 *      plaintext once — walking away with a standalone bearer credential
 *      carrying that user's authority in that user's tenant, outliving the
 *      impersonation and attributed to someone else;
 *   3. `POST /api/v1/me/api-keys` to mint a fresh one, or `DELETE …/[id]` to
 *      destroy theirs.
 *
 * This drives the REAL routes over the REAL account guard (`requireApiAccount`,
 * so the decision under test is the shared one — only the caller resolver and
 * the key repository are stubbed). Every refusal below FAILS without the fix.
 *
 * The controls matter as much as the refusals: an ORDINARY (non-impersonated)
 * session must keep full use of its own keys, and the impersonated READ must
 * keep working — the account panel has to render — so the fix cannot pass by
 * denying everyone.
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
// The account guard reaches `@/lib/audit.server` (mocked above) which imports
// the pool; nothing under test touches the database directly.
vi.mock("@/db/database", () => ({ db: {}, pgPool: {} }));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_ID = "11111111-1111-4111-8111-111111111111";

/** The impersonated TARGET's access context, as the guard would see it. */
const ACCESS = {
  appUserId: "app-target",
  primaryEmail: "target@x.com",
  status: "active",
  organizationId: ORG_A,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view", "account.apikeys.manage"],
};

/**
 * A COOKIE session for the target. `impersonatorId` is the ONLY difference
 * between the attack and the control — everything else about the caller, down
 * to the permissions, is identical.
 */
function sessionCaller(impersonatorId: string | null) {
  return {
    kind: "session",
    betterAuthUserId: "ba-target",
    access: ACCESS,
    grantedScopes: null,
    isBearer: false,
    credentialId: null,
    boundOrganizationId: null,
    impersonatorId,
  };
}

function req(path: string, method: string, body?: unknown): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ origin: "http://test.local", "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

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
  hasBearerCredential.mockReturnValue(false);
  listApiKeysForUser.mockResolvedValue([]);
  // The key the attacker would target: the borrowed user's, in ANOTHER tenant.
  getApiKeyById.mockResolvedValue({
    id: KEY_ID,
    app_user_id: ACCESS.appUserId,
    organization_id: ORG_B,
    status: "active",
    scopes: [],
  });
  rotateApiKey.mockResolvedValue({
    id: "k-new",
    name: "n",
    key_prefix: "drk_live_y",
    scopes: ["admin.users.read"],
    expires_at: null,
    plaintext: "drk_live_y.SECRET",
  });
  revokeApiKey.mockResolvedValue(true);
  createApiKey.mockResolvedValue({
    id: "k-new",
    name: "n",
    key_prefix: "drk_live_y",
    scopes: [],
    expires_at: null,
    plaintext: "drk_live_y.SECRET",
  });
  const rl = await import("@/lib/admin/rate-limit.server");
  rl.__resetRateLimitForTests();
});
afterEach(() => vi.resetModules());

describe("IMP-1: the credential-mutating self-service routes refuse an impersonated session", () => {
  it("POST /api/v1/me/api-keys/[id]/rotate — 403, no secret minted", async () => {
    resolveCaller.mockResolvedValue(sessionCaller("ba-admin"));
    const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");
    const res = await POST(req(`/api/v1/me/api-keys/${KEY_ID}/rotate`, "POST"), params(KEY_ID));

    expect(res.status).toBe(403);
    // The v1 surface answers RFC 7807 (review #45), like every other rejection.
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect((await res.json()) as { code: string }).toMatchObject({ code: "forbidden" });
    // Refused BEFORE the repository — no new plaintext exists to leak, and the
    // old key was not revoked as a side effect.
    expect(rotateApiKey).not.toHaveBeenCalled();
    expect(getApiKeyById).not.toHaveBeenCalled();
  });

  it("POST /api/v1/me/api-keys — 403, no key minted", async () => {
    resolveCaller.mockResolvedValue(sessionCaller("ba-admin"));
    const { POST } = await import("@/app/api/v1/me/api-keys/route");
    const res = await POST(req("/api/v1/me/api-keys", "POST", { name: "k", scopes: [] }));

    expect(res.status).toBe(403);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("DELETE /api/v1/me/api-keys/[id] — 403, nothing revoked", async () => {
    resolveCaller.mockResolvedValue(sessionCaller("ba-admin"));
    const { DELETE } = await import("@/app/api/v1/me/api-keys/[id]/route");
    const res = await DELETE(req(`/api/v1/me/api-keys/${KEY_ID}`, "DELETE"), params(KEY_ID));

    expect(res.status).toBe(403);
    expect(revokeApiKey).not.toHaveBeenCalled();
  });

  it("audits the refusal against the IMPERSONATING ADMIN, not the borrowed identity", async () => {
    // Attribution is the point: an audit row naming the target would say the
    // user attacked their own account.
    resolveCaller.mockResolvedValue(sessionCaller("ba-admin"));
    const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");
    await POST(req(`/api/v1/me/api-keys/${KEY_ID}/rotate`, "POST"), params(KEY_ID));

    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "account.impersonated_access.denied",
        outcome: "denied",
        reason: "forbidden_while_impersonating",
        actorBetterAuthUserId: "ba-admin",
        appUserId: ACCESS.appUserId,
      }),
    );
  });
});

describe("IMP-1: the impersonated key LISTING is confined to the session's own tenant", () => {
  it("GET /api/v1/me/api-keys passes the impersonated session's org as a confinement", async () => {
    resolveCaller.mockResolvedValue(sessionCaller("ba-admin"));
    const { GET } = await import("@/app/api/v1/me/api-keys/route");
    const res = await GET(req("/api/v1/me/api-keys", "GET"));

    // Still 200 — the account panel must render — but the query can no longer
    // return the borrowed user's keys in tenants the admin has no business in.
    expect(res.status).toBe(200);
    expect(listApiKeysForUser).toHaveBeenCalledWith(ACCESS.appUserId, { organizationId: ORG_A });
  });

  it("confines to null (→ empty list) when the impersonated session resolved no org", async () => {
    resolveCaller.mockResolvedValue({
      ...sessionCaller("ba-admin"),
      access: { ...ACCESS, organizationId: null, membershipStatus: "active" },
    });
    const { GET } = await import("@/app/api/v1/me/api-keys/route");
    await GET(req("/api/v1/me/api-keys", "GET"));

    expect(listApiKeysForUser).toHaveBeenCalledWith(ACCESS.appUserId, { organizationId: null });
  });
});

describe("IMP-1 controls: an ordinary session keeps full use of its OWN credentials", () => {
  it("lists account-wide (unconfined) when the caller is not impersonating", async () => {
    resolveCaller.mockResolvedValue(sessionCaller(null));
    const { GET } = await import("@/app/api/v1/me/api-keys/route");
    const res = await GET(req("/api/v1/me/api-keys", "GET"));

    expect(res.status).toBe(200);
    // Exactly one argument: a user acting as themselves sees every key they own.
    expect(listApiKeysForUser).toHaveBeenCalledWith(ACCESS.appUserId);
  });

  it("rotates its own key and receives the new plaintext once", async () => {
    resolveCaller.mockResolvedValue(sessionCaller(null));
    const { POST } = await import("@/app/api/v1/me/api-keys/[id]/rotate/route");
    const res = await POST(req(`/api/v1/me/api-keys/${KEY_ID}/rotate`, "POST"), params(KEY_ID));

    expect(res.status).toBe(201);
    expect((await res.json()) as { key: string }).toMatchObject({ key: "drk_live_y.SECRET" });
    expect(rotateApiKey).toHaveBeenCalledWith(KEY_ID, ACCESS.appUserId);
  });

  it("mints and revokes its own keys", async () => {
    resolveCaller.mockResolvedValue(sessionCaller(null));
    const keys = await import("@/app/api/v1/me/api-keys/route");
    const minted = await keys.POST(req("/api/v1/me/api-keys", "POST", { name: "k", scopes: [] }));
    expect(minted.status).toBe(201);
    expect(createApiKey).toHaveBeenCalled();

    const { DELETE } = await import("@/app/api/v1/me/api-keys/[id]/route");
    const revoked = await DELETE(req(`/api/v1/me/api-keys/${KEY_ID}`, "DELETE"), params(KEY_ID));
    expect(revoked.status).toBe(200);
    expect(revokeApiKey).toHaveBeenCalledWith(KEY_ID, ACCESS.appUserId, "self_revoked");
  });

  it("writes no impersonation-denial audit row for an ordinary caller", async () => {
    resolveCaller.mockResolvedValue(sessionCaller(null));
    const { GET } = await import("@/app/api/v1/me/api-keys/route");
    await GET(req("/api/v1/me/api-keys", "GET"));
    expect(auditEvent).not.toHaveBeenCalled();
  });
});

describe("IMP-1 controls: the non-credential self-service routes still admit impersonation", () => {
  it("GET /api/v1/me answers 200 for an impersonated session (read-only introspection)", async () => {
    resolveCaller.mockResolvedValue(sessionCaller("ba-admin"));
    const { GET } = await import("@/app/api/v1/me/route");
    const res = await GET(req("/api/v1/me", "GET"));

    expect(res.status).toBe(200);
    expect((await res.json()) as { appUserId: string }).toMatchObject({
      appUserId: ACCESS.appUserId,
      organizationId: ORG_A,
    });
    expect(auditEvent).not.toHaveBeenCalled();
  });
});
