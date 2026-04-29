import { describe, expect, it } from "vitest";
import { filterMenuByPermissions } from "@/lib/navigation.server";

/**
 * Pure helper unit tests for `navigation.server.ts` (§29.4.7).
 *
 * The DB-backed `loadApplicationsMenu` / `loadShellMenu` /
 * `loadNestedAppsMenu` functions are exercised by the navigation route
 * integration tests; here we lock down `filterMenuByPermissions`'s
 * behaviour: missing requiredPermissions = always allowed, partial
 * permissions = filtered out, exact match = retained.
 */
describe("filterMenuByPermissions", () => {
  it("keeps items with no requiredPermissions", () => {
    expect(
      filterMenuByPermissions([{ id: "a" }, { id: "b", requiredPermissions: [] }], []),
    ).toEqual([{ id: "a" }, { id: "b", requiredPermissions: [] }]);
  });

  it("filters out items the caller is missing any required permission for", () => {
    const items = [
      { id: "dashboard", requiredPermissions: ["shell.view"] },
      { id: "audit", requiredPermissions: ["audit.view"] },
      { id: "users", requiredPermissions: ["admin.users.manage", "shell.view"] },
    ];
    expect(filterMenuByPermissions(items, ["shell.view", "audit.view"])).toEqual([
      { id: "dashboard", requiredPermissions: ["shell.view"] },
      { id: "audit", requiredPermissions: ["audit.view"] },
    ]);
  });

  it("returns all items when caller has every required permission", () => {
    const items = [
      { id: "x", requiredPermissions: ["a"] },
      { id: "y", requiredPermissions: ["b", "c"] },
    ];
    expect(filterMenuByPermissions(items, ["a", "b", "c"])).toHaveLength(2);
  });

  it("returns an empty array when no permissions are granted", () => {
    expect(filterMenuByPermissions([{ id: "x", requiredPermissions: ["a"] }], [])).toEqual([]);
  });
});
