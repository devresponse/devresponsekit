import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// access-scope.server imports `db` (for the membership helpers). The pure
// decision functions never touch it; the membership helpers run a single
// `.select().where().where().limit().executeTakeFirst()` we route to a fn.
const membershipTakeFirst = vi.fn();
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => {
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "executeTakeFirst") return membershipTakeFirst;
            return () => chain;
          },
        },
      );
      return chain;
    },
  },
}));

import {
  isSuperadmin,
  resolveOrgScope,
  canAccessOrg,
  requiresSuperadminForSharedTarget,
  userHasMembershipOutsideOrg,
  SUPERADMIN_PERMISSION,
  type OrgScope,
} from "@/lib/admin/access-scope.server";

beforeEach(() => membershipTakeFirst.mockReset());
afterEach(() => vi.restoreAllMocks());

/**
 * Unit tests for the three-tier access-control core (ADR-0001). These
 * functions encode the entire authorization decision, so they are tested
 * exhaustively in isolation.
 */
const superadmin = {
  permissions: [SUPERADMIN_PERMISSION, "admin.users.read"],
  organizationId: "org-a",
};
const orgAdmin = {
  permissions: ["admin.users.read", "admin.apikeys.manage"],
  organizationId: "org-a",
};
const orglessAdmin = { permissions: ["admin.users.read"], organizationId: null };

describe("isSuperadmin", () => {
  it("is true only when the superuser marker is held", () => {
    expect(isSuperadmin(superadmin)).toBe(true);
    expect(isSuperadmin(orgAdmin)).toBe(false);
    expect(isSuperadmin({ permissions: [] })).toBe(false);
  });
});

describe("resolveOrgScope", () => {
  it("superadmin → no scoping (all orgs)", () => {
    expect(resolveOrgScope(superadmin)).toEqual({ kind: "all" });
  });
  it("org admin → confined to their single org", () => {
    expect(resolveOrgScope(orgAdmin)).toEqual({ kind: "org", organizationId: "org-a" });
  });
  it("org admin with no active org → null (caller must deny / return empty)", () => {
    expect(resolveOrgScope(orglessAdmin)).toBeNull();
  });
});

describe("canAccessOrg", () => {
  it("superadmin may act on any org, including a null (global) resource", () => {
    expect(canAccessOrg(superadmin, "org-b")).toBe(true);
    expect(canAccessOrg(superadmin, "org-a")).toBe(true);
    expect(canAccessOrg(superadmin, null)).toBe(true);
  });
  it("org admin may act ONLY on an exact match to their own org", () => {
    expect(canAccessOrg(orgAdmin, "org-a")).toBe(true);
    expect(canAccessOrg(orgAdmin, "org-b")).toBe(false);
    // A global/null-org resource is not an org admin's to touch.
    expect(canAccessOrg(orgAdmin, null)).toBe(false);
  });
  it("an admin with no resolvable org can access nothing", () => {
    expect(canAccessOrg(orglessAdmin, "org-a")).toBe(false);
    expect(canAccessOrg(orglessAdmin, null)).toBe(false);
  });
});

describe("userHasMembershipOutsideOrg (AUTHZ-1)", () => {
  it("is true when a membership in another org exists", async () => {
    membershipTakeFirst.mockResolvedValue({ id: "m-other" });
    expect(await userHasMembershipOutsideOrg("u1", "org-a")).toBe(true);
  });
  it("is false when the user has no membership outside the org", async () => {
    membershipTakeFirst.mockResolvedValue(undefined);
    expect(await userHasMembershipOutsideOrg("u1", "org-a")).toBe(false);
  });
});

describe("requiresSuperadminForSharedTarget (AUTHZ-2)", () => {
  const allScope: OrgScope = { kind: "all" };
  const orgScope: OrgScope = { kind: "org", organizationId: "org-a" };

  it("is false for a SUPERADMIN without querying the DB", async () => {
    expect(await requiresSuperadminForSharedTarget(allScope, "u1")).toBe(false);
    expect(membershipTakeFirst).not.toHaveBeenCalled();
  });
  it("is true for an org admin acting on a shared target", async () => {
    membershipTakeFirst.mockResolvedValue({ id: "m-other" });
    expect(await requiresSuperadminForSharedTarget(orgScope, "u1")).toBe(true);
  });
  it("is false for an org admin acting on a single-org target", async () => {
    membershipTakeFirst.mockResolvedValue(undefined);
    expect(await requiresSuperadminForSharedTarget(orgScope, "u1")).toBe(false);
  });
});
