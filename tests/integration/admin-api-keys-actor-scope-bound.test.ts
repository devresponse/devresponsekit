import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";
import type * as RouteModule from "@/app/api/administrator/api-keys/route";

/**
 * Privilege-escalation regression test for `POST /api/administrator/api-keys`.
 *
 * The on-behalf mint must be bounded by BOTH the owner's authority (a key
 * can't out-scope the identity it acts as) AND the acting admin's own
 * grantable authority (an `admin.apikeys.manage` holder must not mint a key
 * carrying scopes they do not personally hold — even for a more-privileged,
 * or superuser, owner — and then wield the returned plaintext to escalate).
 * The sibling `/api/v1/admin/oauth-clients` route already enforces the actor
 * bound; this proves the cookie-session admin route now matches.
 */
const requireAdminMock = vi.fn();
const accessGetter = vi.fn();
const canAccessOrgMock = vi.fn();
const ownerRowExecuteTakeFirst = vi.fn();
const createApiKeyMock = vi.fn();
const auditMock = vi.fn();

// Fully mocked (not importActual) so the real auth chain — auth-guard →
// auth.ts → pgPool — is not pulled into this route-level unit test. The
// denial predicate is the trivial "response in result" check.
vi.mock("@/lib/admin/permissions.server", () => ({
  requireAdminPermission: () => requireAdminMock(),
  isAdminPermissionDenial: (result: unknown) =>
    typeof result === "object" && result !== null && "response" in result,
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/access-scope.server", async () => {
  const actual = await vi.importActual<typeof AccessScopeModule>("@/lib/admin/access-scope.server");
  return { ...actual, canAccessOrg: () => canAccessOrgMock() };
});
vi.mock("@/lib/admin/rate-limit.server", () => ({
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 10, refillMs: 1000 },
  enforceRateLimit: () => undefined,
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  createApiKey: (...args: unknown[]) => createApiKeyMock(...args),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ API_KEY_DEFAULT_TTL_DAYS: null }) }));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...args: unknown[]) => auditMock(...args) }));

// POST performs a single owner lookup ending in `.executeTakeFirst()`.
vi.mock("@/db/database", () => ({
  pgPool: {},
  db: {
    selectFrom: () => {
      const proxy: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "executeTakeFirst") return ownerRowExecuteTakeFirst;
            return () => proxy;
          },
        },
      );
      return proxy;
    },
  },
}));

const OWNER_UUID = "22222222-2222-4222-8222-222222222201";

function makeRequest(body: unknown): NextRequest {
  return {
    nextUrl: new URL("http://test.local/api/administrator/api-keys"),
    url: "http://test.local/api/administrator/api-keys",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

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

/** Grant as returned by the mocked `requireAdminPermission`. */
function grant(actorPermissions: string[], grantedScopes: string[] | null) {
  return {
    betterAuthUserId: "ba-actor",
    access: access({ appUserId: "actor-1", permissions: actorPermissions }),
    requestId: "req-test",
    callerKind: "cookie" as const,
    credentialId: null,
    grantedScopes,
  };
}

let POST: typeof RouteModule.POST;

beforeEach(async () => {
  requireAdminMock.mockReset();
  accessGetter.mockReset();
  canAccessOrgMock.mockReset();
  ownerRowExecuteTakeFirst.mockReset();
  createApiKeyMock.mockReset();
  auditMock.mockReset();

  canAccessOrgMock.mockReturnValue(true);
  ownerRowExecuteTakeFirst.mockResolvedValue({ id: "owner-1", better_auth_user_id: "ba-owner" });
  createApiKeyMock.mockResolvedValue({
    id: "key-1",
    name: "k",
    key_prefix: "drk_live_AbCd1234",
    scopes: ["admin.users.manage"],
    expires_at: null,
    plaintext: "drk_live_secret",
  });
  ({ POST } = await import("@/app/api/administrator/api-keys/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/administrator/api-keys — actor scope bound (privilege escalation)", () => {
  it("REJECTS (422) a non-superadmin minting a co-member's scope they do not hold", async () => {
    // Actor holds only admin.apikeys.manage; owner holds admin.users.manage.
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"], null));
    accessGetter.mockResolvedValue(
      access({ permissions: ["admin.apikeys.manage", "admin.users.manage"] }),
    );

    const res = await POST(
      makeRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["admin.users.manage"] }),
    );

    expect(res.status).toBe(422);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("REJECTS (422) minting a SUPERUSER owner's scope from an apikeys-only admin (the P0 scenario)", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage"], null));
    // Owner is effectively superadmin — holds every admin.* permission.
    accessGetter.mockResolvedValue(
      access({
        appUserId: "owner-1",
        permissions: ["admin.users.manage", "admin.users.delete", "admin.orgs.manage", "superuser"],
      }),
    );

    const res = await POST(
      makeRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["admin.users.manage"] }),
    );

    expect(res.status).toBe(422);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("still REJECTS (422) a scope the OWNER lacks even when the actor could grant it (owner bound preserved)", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage", "admin.users.manage"], null));
    // Owner does NOT hold admin.users.manage.
    accessGetter.mockResolvedValue(access({ permissions: ["admin.apikeys.read"] }));

    const res = await POST(
      makeRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["admin.users.manage"] }),
    );

    expect(res.status).toBe(422);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("ALLOWS (201) when BOTH the actor and the owner hold the requested scope", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.apikeys.manage", "admin.users.manage"], null));
    accessGetter.mockResolvedValue(access({ permissions: ["admin.users.manage"] }));

    const res = await POST(
      makeRequest({ name: "k", ownerAppUserId: OWNER_UUID, scopes: ["admin.users.manage"] }),
    );

    expect(res.status).toBe(201);
    expect(createApiKeyMock).toHaveBeenCalledTimes(1);
  });
});
