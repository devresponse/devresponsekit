import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RouteModule from "@/app/api/administrator/roles/[id]/permissions/route";

/**
 * P1-1 regression: the AUTHZ-3 conferral guard on
 * `POST /api/administrator/roles/[id]/permissions` must bound a BEARER
 * credential by its granted scopes, not merely by its owner's permissions —
 * and must NOT take the SUPERADMIN fast-path for a bearer credential (a
 * superuser-owned but narrowly-scoped key confers only within its scopes).
 * The five sibling conferral routes share the identical wiring
 * (`conferrablePermissions` + the qualified `isSuperadmin` skip).
 *
 * The security suite drives the REAL `requireAdminPermission`, which can't
 * inject a bearer credential's `grantedScopes`, so this mocks the guard
 * directly (the grantable-permissions helper runs for real).
 */
const requireAdminMock = vi.fn();
const auditMock = vi.fn();
const rowExecuteTakeFirst = vi.fn();
const rowsExecute = vi.fn();

vi.mock("@/lib/admin/permissions.server", () => ({
  requireAdminPermission: () => requireAdminMock(),
  isAdminPermissionDenial: (result: unknown) =>
    typeof result === "object" && result !== null && "response" in result,
}));
vi.mock("@/lib/admin/access-scope.server", () => ({
  isSuperadmin: (a: { permissions: string[] }) => a.permissions.includes("superuser"),
  canAccessOrg: () => true,
}));
vi.mock("@/lib/admin/rate-limit.server", () => ({
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 10, refillMs: 1000 },
  enforceRateLimit: () => undefined,
}));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditRoleAction: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("@/db/database", () => ({
  pgPool: {},
  db: {
    selectFrom: () => {
      const proxy: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "executeTakeFirst") return rowExecuteTakeFirst;
            if (prop === "execute") return rowsExecute;
            return () => proxy;
          },
        },
      );
      return proxy;
    },
    transaction: () => ({ execute: async () => undefined }),
  },
}));

const ROLE_ID = "33333333-3333-4333-8333-333333333301";

function req(body: unknown): NextRequest {
  return {
    nextUrl: new URL(`http://test.local/api/administrator/roles/${ROLE_ID}/permissions`),
    url: `http://test.local/api/administrator/roles/${ROLE_ID}/permissions`,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: ROLE_ID }) };

function grant(permissions: string[], grantedScopes: string[] | null) {
  return {
    betterAuthUserId: "ba-actor",
    access: {
      appUserId: "actor-1",
      primaryEmail: "a@x.com",
      status: "active",
      organizationId: "org-a",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions,
    } satisfies AuthStatusModule.UserAccessContext,
    requestId: "req-test",
    callerKind: grantedScopes === null ? ("cookie" as const) : ("api_key" as const),
    credentialId: grantedScopes === null ? null : "key-1",
    grantedScopes,
  };
}

let POST: typeof RouteModule.POST;

beforeEach(async () => {
  requireAdminMock.mockReset();
  auditMock.mockReset();
  rowExecuteTakeFirst.mockReset();
  rowsExecute.mockReset();
  // loadRoleHeader -> a role in the caller's org; catalog/current-keys reads -> [].
  rowExecuteTakeFirst.mockResolvedValue({
    id: ROLE_ID,
    organization_id: "org-a",
    key: "custom.role",
  });
  rowsExecute.mockResolvedValue([]);
  ({ POST } = await import("@/app/api/administrator/roles/[id]/permissions/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/administrator/roles/[id]/permissions — bearer scope bound (P1-1)", () => {
  it("REJECTS (403) a bearer key conferring a permission outside its scopes, even from a superuser owner", async () => {
    // Owner holds admin.users.delete + superuser, but the key is scoped only to
    // admin.roles.update — the superuser fast-path must NOT apply to a bearer.
    requireAdminMock.mockResolvedValue(
      grant(["admin.roles.update", "admin.users.delete", "superuser"], ["admin.roles.update"]),
    );
    const res = await POST(req({ ids: ["admin.users.delete"] }), ctx);
    expect(res.status).toBe(403);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("ALLOWS a bearer key to confer a permission within its (wildcard) scopes", async () => {
    requireAdminMock.mockResolvedValue(
      grant(["admin.roles.update", "admin.users.delete", "superuser"], ["admin.roles.*"]),
    );
    const res = await POST(req({ ids: ["admin.roles.update"] }), ctx);
    expect(res.status).toBe(200);
  });

  it("preserves the SUPERADMIN fast-path for a cookie session (grantedScopes null)", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.roles.update", "superuser"], null));
    const res = await POST(req({ ids: ["admin.users.delete"] }), ctx);
    expect(res.status).toBe(200);
  });

  it("still REJECTS (403) a cookie org-admin conferring a permission they lack (unchanged behavior)", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.roles.update"], null));
    const res = await POST(req({ ids: ["admin.users.delete"] }), ctx);
    expect(res.status).toBe(403);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
