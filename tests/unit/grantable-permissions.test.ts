import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GrantableModule from "@/lib/admin/grantable-permissions.server";

/**
 * Unit tests for the AUTHZ-3 self-grant guard helpers.
 */
const rolePermsExecute = vi.fn();

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => {
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "execute") return rolePermsExecute;
            return () => chain;
          },
        },
      );
      return chain;
    },
  },
}));

let mod: typeof GrantableModule;
beforeEach(async () => {
  rolePermsExecute.mockReset();
  mod = await import("@/lib/admin/grantable-permissions.server");
});
afterEach(() => vi.resetModules());

describe("unheldPermissionKeys", () => {
  it("returns [] when every requested key is held", () => {
    expect(
      mod.unheldPermissionKeys(["admin.users.read", "admin.roles.update"], ["admin.users.read"]),
    ).toEqual([]);
  });

  it("returns the keys the actor does not hold", () => {
    expect(
      mod.unheldPermissionKeys(["admin.roles.update"], ["admin.users.delete", "superuser"]),
    ).toEqual(["admin.users.delete", "superuser"]);
  });

  it("deduplicates the requested keys", () => {
    expect(mod.unheldPermissionKeys([], ["admin.x", "admin.x"])).toEqual(["admin.x"]);
  });

  it("treats an empty request as fully grantable", () => {
    expect(mod.unheldPermissionKeys(["admin.users.read"], [])).toEqual([]);
  });
});

describe("conferrablePermissions (P1-1 bearer scope bound)", () => {
  const held = ["admin.roles.update", "admin.roles.assign", "admin.users.delete", "superuser"];

  it("returns the full held set for a cookie session (null scopes)", () => {
    expect(mod.conferrablePermissions(held, null)).toEqual(held);
  });

  it("filters a bearer credential's held set to its granted scopes", () => {
    expect(mod.conferrablePermissions(held, ["admin.roles.update", "admin.roles.assign"])).toEqual([
      "admin.roles.update",
      "admin.roles.assign",
    ]);
  });

  it("honors wildcard scopes but never authorizes the superuser marker", () => {
    expect(mod.conferrablePermissions(held, ["admin.roles.*"])).toEqual([
      "admin.roles.update",
      "admin.roles.assign",
    ]);
  });

  it("a scoped bearer key cannot confer a permission outside its scopes (even if the owner holds it)", () => {
    // Owner holds admin.users.delete, but the key is scoped only to role editing.
    const conferrable = mod.conferrablePermissions(held, [
      "admin.roles.update",
      "admin.roles.assign",
    ]);
    expect(mod.unheldPermissionKeys(conferrable, ["admin.users.delete"])).toEqual([
      "admin.users.delete",
    ]);
  });

  it("returns [] for a bearer credential with no scopes", () => {
    expect(mod.conferrablePermissions(held, [])).toEqual([]);
  });
});

describe("permissionKeysForRoles", () => {
  it("short-circuits to [] for no role ids (no DB query)", async () => {
    expect(await mod.permissionKeysForRoles([])).toEqual([]);
    expect(rolePermsExecute).not.toHaveBeenCalled();
  });

  it("returns the distinct conferred permission keys", async () => {
    rolePermsExecute.mockResolvedValue([
      { key: "admin.users.read" },
      { key: "admin.users.delete" },
      { key: "admin.users.read" },
    ]);
    expect(await mod.permissionKeysForRoles(["r1", "r2"])).toEqual([
      "admin.users.read",
      "admin.users.delete",
    ]);
  });
});
