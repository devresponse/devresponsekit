import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RolesServerModule from "@/lib/admin/roles.server";
import { pgForeignKeyViolation, pgUniqueViolation } from "../helpers/pg-errors";

/**
 * Residual coverage for roles.server — the DELETE/edit guards that protect
 * referential integrity: a role/permission still referenced must not be
 * deletable, and a missing role surfaces a uniform not-found.
 *
 * F-97: the DELETE guards run inside the deleting transaction and lock the
 * row FOR UPDATE before they count, so `calls` records every builder call
 * (`<table>.<method>`) to pin that order. The real lock semantics are
 * proven against Postgres in tests/db/role-permission-delete-race.db.test.ts.
 */
const state: {
  role: Record<string, unknown> | undefined;
  permission: Record<string, unknown> | undefined;
  userRolesCount: { count: string };
  groupRolesCount: { count: string };
  permUseCount: { count: string };
  permRows: Array<{ key: string }>;
  calls: string[];
} = {
  role: undefined,
  permission: undefined,
  userRolesCount: { count: "0" },
  groupRolesCount: { count: "0" },
  permUseCount: { count: "0" },
  permRows: [],
  calls: [],
};

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
            state.calls.push(`${table}.${String(prop)}`);
            if (prop === "executeTakeFirst")
              return async () =>
                table === "app_roles"
                  ? state.role
                  : table === "app_permissions"
                    ? state.permission
                    : table === "app_user_roles"
                      ? state.userRolesCount
                      : table === "app_group_roles"
                        ? state.groupRolesCount
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
/** The guards take the deleting transaction; the mocked `db` stands in for it. */
let trx: Parameters<typeof RolesServerModule.assertRoleNotInUse>[0];

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
  state.groupRolesCount = { count: "0" };
  state.permUseCount = { count: "0" };
  state.permission = { id: "p1" };
  state.permRows = [{ key: "admin.users.read" }];
  state.calls = [];
  M = await import("@/lib/admin/roles.server");
  trx = (await import("@/db/database")).db as unknown as typeof trx;
});
afterEach(() => vi.resetModules());

/** The builder calls on `table`, in order, method names only. */
function callsOn(table: string): string[] {
  return state.calls.filter((c) => c.startsWith(`${table}.`)).map((c) => c.slice(table.length + 1));
}

describe("assertRoleNotInUse", () => {
  it("resolves when no assignment references the role", async () => {
    await expect(M.assertRoleNotInUse(trx, "r1")).resolves.toBeUndefined();
  });
  it("throws role_in_use when direct user assignments still exist", async () => {
    state.userRolesCount = { count: "3" };
    await expect(M.assertRoleNotInUse(trx, "r1")).rejects.toMatchObject({ code: "role_in_use" });
  });
  it("throws role_in_use when only a group confers the role (DB-2)", async () => {
    // No direct user assignment, but a group bundles the role — deleting it
    // would silently cascade-strip the group_role row instead of 409.
    state.userRolesCount = { count: "0" };
    state.groupRolesCount = { count: "1" };
    await expect(M.assertRoleNotInUse(trx, "r1")).rejects.toMatchObject({ code: "role_in_use" });
  });
  it("F-97: locks the role row FOR UPDATE before it counts", async () => {
    await M.assertRoleNotInUse(trx, "r1");
    expect(callsOn("app_roles")).toContain("forUpdate");
    const lockedAt = state.calls.indexOf("app_roles.executeTakeFirst");
    const firstCount = state.calls.findIndex((c) => /^app_(user|group)_roles\./.test(c));
    expect(lockedAt).toBeGreaterThanOrEqual(0);
    expect(lockedAt).toBeLessThan(firstCount);
  });
  it("F-97: throws role_not_found when the role is gone by the time it is locked", async () => {
    state.role = undefined;
    await expect(M.assertRoleNotInUse(trx, "r1")).rejects.toMatchObject({
      code: "role_not_found",
    });
  });
});

describe("assertPermissionNotInUse", () => {
  it("resolves when the permission is unused", async () => {
    await expect(M.assertPermissionNotInUse(trx, "p1")).resolves.toBeUndefined();
  });
  it("throws permission_in_use when a role still references it", async () => {
    state.permUseCount = { count: "2" };
    await expect(M.assertPermissionNotInUse(trx, "p1")).rejects.toMatchObject({
      code: "permission_in_use",
    });
  });
  it("F-97: locks the permission row FOR UPDATE before it counts", async () => {
    await M.assertPermissionNotInUse(trx, "p1");
    expect(callsOn("app_permissions")).toContain("forUpdate");
    expect(state.calls.indexOf("app_permissions.executeTakeFirst")).toBeLessThan(
      state.calls.indexOf("app_role_permissions.executeTakeFirst"),
    );
  });
  it("F-97: throws permission_not_found when the permission is gone by the time it is locked", async () => {
    state.permission = undefined;
    await expect(M.assertPermissionNotInUse(trx, "p1")).rejects.toMatchObject({
      code: "permission_not_found",
    });
  });
});

describe("isForeignKeyViolation", () => {
  it("is true only for SQLSTATE 23503, of any constraint, read through pg-errors (F-132)", () => {
    expect(M.isForeignKeyViolation(pgForeignKeyViolation("app_user_roles_role_id_fkey"))).toBe(
      true,
    );
    expect(
      M.isForeignKeyViolation(pgForeignKeyViolation("app_role_permissions_permission_id_fkey")),
    ).toBe(true);
    expect(M.isForeignKeyViolation(pgUniqueViolation("app_roles_organization_id_key_key"))).toBe(
      false,
    );
    // The message text alone is not a violation.
    expect(M.isForeignKeyViolation(new Error("violates foreign key constraint"))).toBe(false);
    expect(M.isForeignKeyViolation(new Error("plain"))).toBe(false);
    expect(M.isForeignKeyViolation(null)).toBe(false);
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
