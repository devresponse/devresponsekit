import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RolesServerModule from "@/lib/admin/roles.server";

/**
 * Residual coverage for roles.server — the DELETE/edit guards that protect
 * referential integrity: a role/permission still referenced must not be
 * deletable, and a missing role surfaces a uniform not-found.
 */
const state: {
  role: Record<string, unknown> | undefined;
  userRolesCount: { count: string };
  permUseCount: { count: string };
  permRows: Array<{ key: string }>;
} = { role: undefined, userRolesCount: { count: "0" }, permUseCount: { count: "0" }, permRows: [] };

function tableKey(t: unknown) {
  return String(t).split(" ")[0] ?? "";
}
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (t: unknown) => {
      const table = tableKey(t);
      const proxy: unknown = new Proxy(
        {},
        {
          get(_x, prop) {
            if (prop === "executeTakeFirst")
              return async () =>
                table === "app_roles"
                  ? state.role
                  : table === "app_user_roles"
                    ? state.userRolesCount
                    : table === "app_role_permissions"
                      ? state.permUseCount
                      : undefined;
            if (prop === "execute")
              return async () => (table === "app_role_permissions" ? state.permRows : []);
            // Chain methods return the SAME proxy so the terminal call routes here.
            return () => proxy;
          },
        },
      );
      return proxy;
    },
  },
}));

let M: typeof RolesServerModule;

beforeEach(async () => {
  state.role = {
    id: "r1",
    organization_id: "o1",
    key: "editor",
    name: "Editor",
    description: null,
    created_at: "2026-01-01",
  };
  state.userRolesCount = { count: "0" };
  state.permUseCount = { count: "0" };
  state.permRows = [{ key: "admin.users.read" }];
  M = await import("@/lib/admin/roles.server");
});
afterEach(() => vi.resetModules());

describe("assertRoleNotInUse", () => {
  it("resolves when no assignment references the role", async () => {
    await expect(M.assertRoleNotInUse("r1")).resolves.toBeUndefined();
  });
  it("throws role_in_use when assignments still exist", async () => {
    state.userRolesCount = { count: "3" };
    await expect(M.assertRoleNotInUse("r1")).rejects.toMatchObject({ code: "role_in_use" });
  });
});

describe("assertPermissionNotInUse", () => {
  it("resolves when the permission is unused", async () => {
    await expect(M.assertPermissionNotInUse("p1")).resolves.toBeUndefined();
  });
  it("throws permission_in_use when a role still references it", async () => {
    state.permUseCount = { count: "2" };
    await expect(M.assertPermissionNotInUse("p1")).rejects.toMatchObject({
      code: "permission_in_use",
    });
  });
});

describe("loadRoleOrThrow", () => {
  it("throws role_not_found when the row is absent", async () => {
    state.role = undefined;
    await expect(M.loadRoleOrThrow("missing")).rejects.toMatchObject({ code: "role_not_found" });
  });
  it("returns the role with its permission keys and member count", async () => {
    state.userRolesCount = { count: "5" };
    const role = await M.loadRoleOrThrow("r1");
    expect(role).toMatchObject({
      id: "r1",
      key: "editor",
      permissionKeys: ["admin.users.read"],
      memberCount: 5,
    });
  });
});
