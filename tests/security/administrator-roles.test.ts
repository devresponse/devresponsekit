import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RolesRouteModule from "@/app/api/administrator/roles/route";
import type * as PermissionsRouteModule from "@/app/api/administrator/permissions/route";
import type * as PermissionByIdRouteModule from "@/app/api/administrator/permissions/[id]/route";
import type * as AppRolesRouteModule from "@/app/api/administrator/users/[id]/app-roles/route";

/**
 * Security tests for the roles endpoints (docs/admin-manager.md §4
 * + §12). Pin the authorization boundary: every mutating verb must be
 * gated by the right permission AND every probing call must be audited
 * with `outcome=denied` so ops can detect privilege escalation
 * attempts.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

vi.mock("@/db/database", () => {
  function makeChain() {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "execute") return itemsExecute;
          if (prop === "executeTakeFirst") return selectFirst;
          if (prop === "executeTakeFirstOrThrow") return selectFirst;
          return (...args: unknown[]) => {
            const cb = args[0];
            if (typeof cb === "function") {
              try {
                (cb as (eb: unknown) => unknown)(
                  new Proxy(() => ({}), {
                    get: () => () => ({}),
                    apply: () => ({}),
                  }),
                );
              } catch {
                /* ignore */
              }
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return {
    db: {
      selectFrom: () => makeChain(),
      insertInto: () => ({
        values: () => ({
          returning: () => ({ executeTakeFirstOrThrow: selectFirst }),
          onConflict: () => ({ execute: itemsExecute }),
        }),
      }),
      updateTable: () => ({
        set: () => ({ where: () => ({ execute: itemsExecute }) }),
      }),
      deleteFrom: () => ({
        where: () => ({
          execute: itemsExecute,
          where: () => ({ execute: itemsExecute, where: () => ({ execute: itemsExecute }) }),
        }),
      }),
      transaction: () => ({
        execute: async (cb: (trx: unknown) => Promise<unknown>) => {
          await cb({
            deleteFrom: () => ({
              where: () => ({
                execute: vi.fn().mockResolvedValue(undefined),
                where: () => ({ execute: vi.fn().mockResolvedValue(undefined) }),
              }),
            }),
            insertInto: () => ({
              values: () => ({
                onConflict: () => ({ execute: vi.fn().mockResolvedValue(undefined) }),
              }),
            }),
          });
        },
      }),
    },
  };
});

function rolesGet(): NextRequest {
  return {
    nextUrl: new URL("http://test.local/api/administrator/roles"),
    headers: new Headers(),
  } as unknown as NextRequest;
}
function jsonReq(url: string, body: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const ACCESS = (perms: string[]) => ({
  appUserId: "u-1",
  primaryEmail: "x@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: perms,
});

let RolesGET: typeof RolesRouteModule.GET;
let RolesPOST: typeof RolesRouteModule.POST;
let PermsPOST: typeof PermissionsRouteModule.POST;
let PermsDelete: typeof PermissionByIdRouteModule.DELETE;
let AppRolesPOST: typeof AppRolesRouteModule.POST;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock, itemsExecute, selectFirst])
    m.mockReset();
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({ total: "0" });
  ({ GET: RolesGET, POST: RolesPOST } = await import("@/app/api/administrator/roles/route"));
  ({ POST: PermsPOST } = await import("@/app/api/administrator/permissions/route"));
  ({ DELETE: PermsDelete } = await import("@/app/api/administrator/permissions/[id]/route"));
  ({ POST: AppRolesPOST } = await import("@/app/api/administrator/users/[id]/app-roles/route"));
});
afterEach(() => vi.resetModules());

describe("security: roles list", () => {
  it("rejects unauthenticated callers without touching the database", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await RolesGET(rolesGet());
    expect(res.status).toBe(401);
    expect(itemsExecute).not.toHaveBeenCalled();
  });

  it("rejects callers missing admin.roles.read without touching the database", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["shell.view"]));
    const res = await RolesGET(rolesGet());
    expect(res.status).toBe(403);
    expect(itemsExecute).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("rejects suspended admins (status check beats permission check)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      ...ACCESS(["admin.roles.read"]),
      status: "suspended",
      membershipStatus: "suspended",
    });
    const res = await RolesGET(rolesGet());
    expect(res.status).toBe(403);
    expect(itemsExecute).not.toHaveBeenCalled();
  });
});

describe("security: roles create requires admin.roles.create (not just read)", () => {
  it("403 when caller has read but not create", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.roles.read"]));
    const res = await RolesPOST(
      jsonReq("http://test.local/api/administrator/roles", {
        key: "x.y",
        name: "X",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("security: permission catalog mutations require admin.permissions.manage", () => {
  it("rejects POST /permissions for callers with only admin.roles.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.roles.read", "admin.roles.create"]));
    const res = await PermsPOST(
      jsonReq("http://test.local/api/administrator/permissions", {
        key: "x.y",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects DELETE /permissions/[id] for callers with only admin.roles.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.roles.read"]));
    const res = await PermsDelete(
      jsonReq("http://test.local/api/administrator/permissions/p-1", {}),
      {
        params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("security: assigning roles to users requires admin.roles.assign", () => {
  it("403 when caller has admin.users.update but lacks admin.roles.assign", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.users.update"]));
    const res = await AppRolesPOST(
      jsonReq("http://test.local/api/administrator/users/u-1/app-roles", {
        roleId: "11111111-1111-4111-8111-111111111111",
        organizationId: "22222222-2222-4222-8222-222222222222",
      }),
      {
        params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
      },
    );
    expect(res.status).toBe(403);
  });
});
