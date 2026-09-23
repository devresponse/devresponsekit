import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";
import type * as CreateRouteModule from "@/app/api/administrator/api-keys/route";
import type * as RotateRouteModule from "@/app/api/administrator/api-keys/[id]/rotate/route";

/**
 * MACHINE-2 layer 2 — the MINT-TIME owner-reach bound.
 *
 * The on-behalf credential routes hand the ACTOR a one-time secret for a
 * credential that authenticates as SOMEONE ELSE. Their pre-existing bounds
 * constrain which SCOPE NAMES may ride along (the owner's held set ∩ the
 * actor's grantable set) and say nothing about the owner's org REACH — so an
 * org admin holding only `admin.apikeys.manage` could mint on behalf of a
 * SUPERUSER co-member using scopes they themselves hold, pass both bounds, and
 * wield a platform-wide credential.
 *
 * Layer 1 already caps such a credential at USE time; this proves the mint is
 * refused outright, so the caller gets an actionable 403 rather than a
 * credential that quietly does less than they asked for.
 *
 * `tests/integration/admin-api-keys-actor-scope-bound.test.ts` is the sibling
 * that pins the SCOPE bounds; this file pins only the reach bound, using the
 * same route-level mocking style (the real `requireAdminPermission` cannot
 * inject a bearer credential's grant).
 */
const requireAdminMock = vi.fn();
const accessGetter = vi.fn();
const canAccessOrgMock = vi.fn();
const globalSuperuserMock = vi.fn();
const rowExecuteTakeFirst = vi.fn();
const createApiKeyMock = vi.fn();
const rotateApiKeyMock = vi.fn();
const auditMock = vi.fn();

vi.mock("@/lib/admin/permissions.server", () => ({
  requireAdminPermission: () => requireAdminMock(),
  isAdminPermissionDenial: (result: unknown) =>
    typeof result === "object" && result !== null && "response" in result,
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
// `isSuperadmin` / `ownerOutranksActor` run for REAL — they are the rule under
// test. Only the two DB-backed helpers are stubbed.
vi.mock("@/lib/admin/access-scope.server", async () => {
  const actual = await vi.importActual<typeof AccessScopeModule>("@/lib/admin/access-scope.server");
  return {
    ...actual,
    canAccessOrg: () => canAccessOrgMock(),
    userIsGlobalSuperuser: () => globalSuperuserMock(),
  };
});
vi.mock("@/lib/admin/rate-limit.server", () => ({
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 10, refillMs: 1000 },
  enforceRateLimit: () => undefined,
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  createApiKey: (...args: unknown[]) => createApiKeyMock(...args),
  rotateApiKey: (...args: unknown[]) => rotateApiKeyMock(...args),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ API_KEY_DEFAULT_TTL_DAYS: null }) }));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...args: unknown[]) => auditMock(...args) }));

vi.mock("@/db/database", () => ({
  pgPool: {},
  db: {
    selectFrom: () => {
      const proxy: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "executeTakeFirst") return rowExecuteTakeFirst;
            return () => proxy;
          },
        },
      );
      return proxy;
    },
  },
}));

const OWNER_UUID = "22222222-2222-4222-8222-222222222201";
const KEY_ID = "11111111-1111-4111-8111-111111111101";

function access(
  overrides: Partial<AuthStatusModule.UserAccessContext>,
): AuthStatusModule.UserAccessContext {
  return {
    appUserId: "actor-1",
    primaryEmail: "a@x.com",
    status: "active",
    organizationId: "org-a",
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: ["admin.apikeys.manage"],
    ...overrides,
  };
}

function grant(actorPermissions: string[]) {
  return {
    betterAuthUserId: "ba-actor",
    access: access({ appUserId: "actor-1", permissions: actorPermissions }),
    requestId: "req-test",
    callerKind: "cookie" as const,
    credentialId: null,
    grantedScopes: null,
  };
}

function createRequest(body: unknown): NextRequest {
  return {
    nextUrl: new URL("http://test.local/api/administrator/api-keys"),
    url: "http://test.local/api/administrator/api-keys",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

function rotateRequest(): NextRequest {
  return {
    nextUrl: new URL(`http://test.local/api/administrator/api-keys/${KEY_ID}/rotate`),
    url: `http://test.local/api/administrator/api-keys/${KEY_ID}/rotate`,
    headers: new Headers(),
  } as unknown as NextRequest;
}
const rotateCtx = { params: Promise.resolve({ id: KEY_ID }) };

let POST: typeof CreateRouteModule.POST;
let ROTATE: typeof RotateRouteModule.POST;

beforeEach(async () => {
  for (const m of [
    requireAdminMock,
    accessGetter,
    canAccessOrgMock,
    globalSuperuserMock,
    rowExecuteTakeFirst,
    createApiKeyMock,
    rotateApiKeyMock,
    auditMock,
  ]) {
    m.mockReset();
  }
  canAccessOrgMock.mockReturnValue(true);
  globalSuperuserMock.mockResolvedValue(false);
  rowExecuteTakeFirst.mockResolvedValue({
    id: "owner-1",
    better_auth_user_id: "ba-owner",
    // rotate's key row
    app_user_id: OWNER_UUID,
    status: "active",
    organization_id: "org-a",
    // A key scoped within the actor's own authority: the rotations below that
    // are ALLOWED stay allowed under the F-01 scope bound.
    scopes: ["admin.apikeys.manage"],
  });
  createApiKeyMock.mockResolvedValue({
    id: "key-1",
    name: "k",
    key_prefix: "drk_live_AbCd1234",
    scopes: ["admin.apikeys.manage"],
    expires_at: null,
    plaintext: "drk_live_secret",
  });
  rotateApiKeyMock.mockResolvedValue({
    id: "key-2",
    name: "k",
    key_prefix: "drk_live_EfGh5678",
    scopes: ["admin.users.delete"],
    expires_at: null,
    plaintext: "drk_live_rotated",
  });
  ({ POST } = await import("@/app/api/administrator/api-keys/route"));
  ({ POST: ROTATE } = await import("@/app/api/administrator/api-keys/[id]/rotate/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/administrator/api-keys — owner-reach bound (MACHINE-2)", () => {
  it("REFUSES (403) an org admin minting on behalf of a SUPERUSER owner, even with scopes they hold", async () => {
    // The exploit: every requested scope is one the actor holds AND the owner
    // holds, so Bound 1 and Bound 2 both pass. Only the reach bound stops it.
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
    accessGetter.mockResolvedValue(
      access({ appUserId: "owner-1", permissions: ["admin.apikeys.manage", "superuser"] }),
    );

    const res = await POST(
      createRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["admin.apikeys.manage"] }),
    );

    expect(res.status).toBe(403);
    expect(createApiKeyMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", reason: "owner_outranks_actor" }),
    );
  });

  it("ALLOWS (201) a SUPERADMIN actor to mint for a superuser owner", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage", "superuser"]));
    accessGetter.mockResolvedValue(
      access({ appUserId: "owner-1", permissions: ["admin.apikeys.manage", "superuser"] }),
    );

    const res = await POST(
      createRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["admin.apikeys.manage"] }),
    );

    expect(res.status).toBe(201);
    expect(createApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("F-01: REFUSES (422) an account-WRITING scope on a key for ANOTHER person", async () => {
    // `account.*` is self-grantable, so Bound 2 used to pass it for any owner.
    // A key authenticating as the owner with `account.apikeys.manage` let the
    // actor list and rotate the owner's keys in OTHER tenants via /api/v1/me.
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
    accessGetter.mockResolvedValue(
      access({ appUserId: "owner-1", permissions: ["admin.apikeys.manage"] }),
    );

    const res = await POST(
      createRequest({
        name: "k",
        ownerAppUserId: OWNER_UUID,
        scopes: ["account.read", "account.apikeys.manage"],
      }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { ungrantableScopes: string[] };
    // `account.read` stays grantable on behalf (read-only, tenant-confined).
    expect(body.ungrantableScopes).toEqual(["account.apikeys.manage"]);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("F-01: ALLOWS (201) account-writing scopes on a key the actor mints for THEMSELVES", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
    accessGetter.mockResolvedValue(access({ permissions: ["admin.apikeys.manage"] }));
    // The owner row IS the actor.
    rowExecuteTakeFirst.mockResolvedValue({ id: "actor-1", better_auth_user_id: "ba-actor" });

    const res = await POST(
      createRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["account.apikeys.manage"] }),
    );

    expect(res.status).toBe(201);
    expect(createApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("F-01: REFUSES (422) an IMPERSONATED session minting account-writing scopes for the borrowed user", async () => {
    // The session carries the borrowed user's appUserId ("actor-1" here, the
    // owner row too) — only `impersonatorId` says it is not really them.
    requireAdminMock.mockResolvedValue({
      ...grant(["admin.apikeys.manage"]),
      impersonatorId: "ba-real-admin",
    });
    accessGetter.mockResolvedValue(access({ permissions: ["admin.apikeys.manage"] }));
    rowExecuteTakeFirst.mockResolvedValue({ id: "actor-1", better_auth_user_id: "ba-actor" });

    const res = await POST(
      createRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["account.apikeys.manage"] }),
    );

    expect(res.status).toBe(422);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("ALLOWS (201) an org admin minting for an ORDINARY owner (unchanged behaviour)", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
    accessGetter.mockResolvedValue(
      access({ appUserId: "owner-1", permissions: ["admin.apikeys.manage"] }),
    );

    const res = await POST(
      createRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["admin.apikeys.manage"] }),
    );

    expect(res.status).toBe(201);
    expect(createApiKeyMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/administrator/api-keys/[id]/rotate — owner-reach bound (MACHINE-2)", () => {
  it("REFUSES (403) an org admin reissuing a SUPERUSER owner's key", async () => {
    // Rotation carries the ORIGINAL scopes forward verbatim, so it never passed
    // through the scope bounds at all — the reach bound is the only guard.
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
    globalSuperuserMock.mockResolvedValue(true);

    const res = await ROTATE(rotateRequest(), rotateCtx);

    expect(res.status).toBe(403);
    expect(rotateApiKeyMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", reason: "owner_outranks_actor" }),
    );
  });

  it("ALLOWS (201) a SUPERADMIN actor to rotate a superuser owner's key", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage", "superuser"]));
    globalSuperuserMock.mockResolvedValue(true);

    const res = await ROTATE(rotateRequest(), rotateCtx);

    expect(res.status).toBe(201);
    expect(rotateApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("F-01: REFUSES (403) an org admin rotating a key carrying scopes they do NOT hold", async () => {
    // This was a 201 before F-01: rotation carried the key's scopes forward
    // verbatim and only the SUPERUSER reach bound ran, so an actor holding only
    // `admin.apikeys.manage` received a co-member's `admin.users.delete` key.
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
    globalSuperuserMock.mockResolvedValue(false);
    rowExecuteTakeFirst.mockResolvedValue({
      id: "owner-1",
      better_auth_user_id: "ba-owner",
      app_user_id: OWNER_UUID,
      status: "active",
      organization_id: "org-a",
      scopes: ["admin.users.delete"],
    });

    const res = await ROTATE(rotateRequest(), rotateCtx);

    expect(res.status).toBe(403);
    expect(rotateApiKeyMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", reason: "scope_not_grantable" }),
    );
  });

  it("F-01: REFUSES (403) rotating another person's key that carries account.* scopes", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
    rowExecuteTakeFirst.mockResolvedValue({
      id: "owner-1",
      better_auth_user_id: "ba-owner",
      app_user_id: OWNER_UUID,
      status: "active",
      organization_id: "org-a",
      scopes: ["account.apikeys.manage"],
    });

    const res = await ROTATE(rotateRequest(), rotateCtx);

    expect(res.status).toBe(403);
    expect(rotateApiKeyMock).not.toHaveBeenCalled();
  });

  it("F-01: REFUSES (403) a narrow BEARER actor rotating a key broader than its own scopes", async () => {
    // The owner of the calling credential HOLDS admin.users.delete, but the
    // credential itself was scoped to admin.apikeys.manage only.
    requireAdminMock.mockResolvedValue({
      ...grant(["admin.apikeys.manage", "admin.users.delete"]),
      callerKind: "api_key" as const,
      grantedScopes: ["admin.apikeys.manage"],
    });
    rowExecuteTakeFirst.mockResolvedValue({
      id: "owner-1",
      better_auth_user_id: "ba-owner",
      app_user_id: OWNER_UUID,
      status: "active",
      organization_id: "org-a",
      scopes: ["admin.users.delete"],
    });

    const res = await ROTATE(rotateRequest(), rotateCtx);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { ungrantableScopes: string[] };
    expect(body.ungrantableScopes).toEqual(["admin.users.delete"]);
    expect(rotateApiKeyMock).not.toHaveBeenCalled();
  });

  it("ALLOWS (201) a BEARER actor whose own scopes cover the rotated key", async () => {
    requireAdminMock.mockResolvedValue({
      ...grant(["admin.apikeys.manage", "admin.users.delete"]),
      callerKind: "api_key" as const,
      grantedScopes: ["admin.apikeys.manage", "admin.users.delete"],
    });
    rowExecuteTakeFirst.mockResolvedValue({
      id: "owner-1",
      better_auth_user_id: "ba-owner",
      app_user_id: OWNER_UUID,
      status: "active",
      organization_id: "org-a",
      scopes: ["admin.users.delete"],
    });

    const res = await ROTATE(rotateRequest(), rotateCtx);

    expect(res.status).toBe(201);
  });

  describe("F-01: an IMPERSONATED session is not the owner of the borrowed user's key", () => {
    // The session carries the borrowed user's appUserId ("actor-1"), so the key
    // looks like the actor's own; only `impersonatorId` says otherwise.
    const ownKeyRow = {
      id: "actor-1",
      better_auth_user_id: "ba-actor",
      app_user_id: "actor-1",
      status: "active",
      organization_id: "org-a",
      scopes: ["account.apikeys.manage"],
    };

    it("REFUSES (403) rotating it when it carries an account-writing scope", async () => {
      requireAdminMock.mockResolvedValue({
        ...grant(["admin.apikeys.manage"]),
        impersonatorId: "ba-real-admin",
      });
      rowExecuteTakeFirst.mockResolvedValue(ownKeyRow);

      const res = await ROTATE(rotateRequest(), rotateCtx);

      expect(res.status).toBe(403);
      expect(rotateApiKeyMock).not.toHaveBeenCalled();
    });

    it("control: the owner themselves (not impersonating) may rotate it (201)", async () => {
      requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
      rowExecuteTakeFirst.mockResolvedValue(ownKeyRow);

      const res = await ROTATE(rotateRequest(), rotateCtx);

      expect(res.status).toBe(201);
    });
  });

  it("ALLOWS (201) an org admin rotating an ORDINARY owner's key within their own authority", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"]));
    globalSuperuserMock.mockResolvedValue(false);

    const res = await ROTATE(rotateRequest(), rotateCtx);

    expect(res.status).toBe(201);
    expect(rotateApiKeyMock).toHaveBeenCalledTimes(1);
  });
});
