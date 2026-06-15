import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";

/**
 * Closes the residual branch coverage on access-scope.server: the async,
 * DB-backed `userHasMembershipInOrg` / `canAccessUser` helpers that
 * org-scope `app_users` access (a user's tenant IS its membership). The
 * membership lookup is mocked.
 */
const takeFirst = vi.fn();
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => {
      // Chain methods must return the SAME proxy so `.select().where().where()`
      // keeps routing `.executeTakeFirst` to the mock.
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "executeTakeFirst") return takeFirst;
            return () => proxy;
          },
        },
      );
      return proxy;
    },
  },
}));

let M: typeof AccessScopeModule;

beforeEach(async () => {
  takeFirst.mockReset();
  M = await import("@/lib/admin/access-scope.server");
});
afterEach(() => vi.resetModules());

describe("userHasMembershipInOrg", () => {
  it("true when a membership row exists", async () => {
    takeFirst.mockResolvedValue({ id: "m1" });
    expect(await M.userHasMembershipInOrg("u1", "org-a")).toBe(true);
  });
  it("false when no row exists", async () => {
    takeFirst.mockResolvedValue(undefined);
    expect(await M.userHasMembershipInOrg("u1", "org-a")).toBe(false);
  });
});

describe("canAccessUser", () => {
  it("SUPERADMIN may access any user WITHOUT a DB lookup", async () => {
    const access = { permissions: ["superuser"], organizationId: null };
    expect(await M.canAccessUser(access, "u1")).toBe(true);
    expect(takeFirst).not.toHaveBeenCalled();
  });

  it("an admin with no org can access no user (no DB lookup)", async () => {
    const access = { permissions: ["admin.users.read"], organizationId: null };
    expect(await M.canAccessUser(access, "u1")).toBe(false);
    expect(takeFirst).not.toHaveBeenCalled();
  });

  it("an ORG ADMIN may access a user holding a membership in their org", async () => {
    takeFirst.mockResolvedValue({ id: "m1" });
    const access = { permissions: ["admin.users.read"], organizationId: "org-a" };
    expect(await M.canAccessUser(access, "u1")).toBe(true);
  });

  it("an ORG ADMIN may NOT access a user outside their org", async () => {
    takeFirst.mockResolvedValue(undefined);
    const access = { permissions: ["admin.users.read"], organizationId: "org-a" };
    expect(await M.canAccessUser(access, "u1")).toBe(false);
  });
});

describe("userIsGlobalSuperuser", () => {
  it("true when the user holds the superuser marker via an active membership", async () => {
    takeFirst.mockResolvedValue({ id: "p1" });
    expect(await M.userIsGlobalSuperuser("u1")).toBe(true);
  });
  it("false when no such row exists", async () => {
    takeFirst.mockResolvedValue(undefined);
    expect(await M.userIsGlobalSuperuser("u1")).toBe(false);
  });
});
