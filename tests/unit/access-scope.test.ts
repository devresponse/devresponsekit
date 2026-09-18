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
  canAccessUser,
  hasCrossOrgReach,
  isOrgBound,
  isSuperadmin,
  ownerOutranksActor,
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

/**
 * MACHINE-2 fixtures — the SAME superuser principal, once behind a cookie
 * session and once behind a bearer credential minted in org-a. The permission
 * SET is identical (a bound superuser really does hold every capability inside
 * its bound tenant); only `orgBound` differs, and that alone must collapse its
 * REACH to org-a.
 */
const boundSuperadmin = {
  permissions: [SUPERADMIN_PERMISSION, "admin.users.read"],
  organizationId: "org-a",
  orgBound: true,
};
/** A bound credential whose principal holds no membership in the bound org. */
const boundSuperadminNoOrg = {
  permissions: [SUPERADMIN_PERMISSION, "admin.users.read"],
  organizationId: null,
  orgBound: true,
};

describe("isSuperadmin", () => {
  it("is true only when the superuser marker is held", () => {
    expect(isSuperadmin(superadmin)).toBe(true);
    expect(isSuperadmin(orgAdmin)).toBe(false);
    expect(isSuperadmin({ permissions: [] })).toBe(false);
  });

  it("keeps its IDENTITY meaning for an org-bound credential (MACHINE-2)", () => {
    // The cap belongs to the scope helpers, not to this predicate: the
    // principal IS a superadmin, and route guards that ask "does this caller
    // hold the permission" must keep getting `true`.
    expect(isSuperadmin(boundSuperadmin)).toBe(true);
  });
});

describe("isOrgBound / hasCrossOrgReach (MACHINE-2)", () => {
  it("treats an absent marker as NOT bound (every pre-existing context)", () => {
    // `{}` stands for every hand-built context that predates the marker: it
    // must read as "not bound", i.e. exactly the old behaviour.
    expect(isOrgBound({})).toBe(false);
    expect(isOrgBound({ orgBound: false })).toBe(false);
    expect(isOrgBound({ orgBound: true })).toBe(true);
  });

  it("grants cross-org reach ONLY to an unbound superadmin", () => {
    expect(hasCrossOrgReach(superadmin)).toBe(true);
    expect(hasCrossOrgReach(boundSuperadmin)).toBe(false);
    expect(hasCrossOrgReach(orgAdmin)).toBe(false);
    // A bound NON-superadmin was already confined; nothing changes for them.
    expect(hasCrossOrgReach({ ...orgAdmin, orgBound: true })).toBe(false);
  });
});

describe("ownerOutranksActor (MACHINE-2 layer 2 — mint-time bound)", () => {
  it("refuses a superuser owner to a non-superadmin actor", () => {
    expect(ownerOutranksActor(true, orgAdmin)).toBe(true);
  });
  it("allows a superadmin actor to mint for a superuser owner", () => {
    expect(ownerOutranksActor(true, superadmin)).toBe(false);
    // Including an org-bound superuser actor: the credential it mints is
    // capped to the same single tenant the actor is itself capped to.
    expect(ownerOutranksActor(true, boundSuperadmin)).toBe(false);
  });
  it("is irrelevant for an ordinary owner", () => {
    expect(ownerOutranksActor(false, orgAdmin)).toBe(false);
    expect(ownerOutranksActor(false, superadmin)).toBe(false);
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

  /**
   * MACHINE-2 regression. Before the fix these three assertions read
   * `{ kind: "all" }` for a superuser-owned BOUND credential, which is exactly
   * how a key minted in org-a reached every tenant's list endpoint.
   */
  it("org-bound superuser credential → its BOUND org, never {kind:'all'}", () => {
    expect(resolveOrgScope(boundSuperadmin)).toEqual({ kind: "org", organizationId: "org-a" });
  });
  it("org-bound superuser credential with no resolvable org → null (deny), never 'all'", () => {
    expect(resolveOrgScope(boundSuperadminNoOrg)).toBeNull();
  });
  it("leaves the cookie-session superadmin unscoped (no behaviour change at a browser)", () => {
    expect(resolveOrgScope({ ...superadmin, orgBound: false })).toEqual({ kind: "all" });
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

  /**
   * MACHINE-2 regression: every `[id]` route in the admin + v1 surfaces derives
   * its 404 from this predicate, so before the fix a superuser-owned key minted
   * in org-a returned 200 for org-b's rows.
   */
  it("org-bound superuser credential is held to the exact-match rule", () => {
    expect(canAccessOrg(boundSuperadmin, "org-a")).toBe(true);
    expect(canAccessOrg(boundSuperadmin, "org-b")).toBe(false);
    // A platform-global (null-org) record has no tenant to match — unreachable.
    expect(canAccessOrg(boundSuperadmin, null)).toBe(false);
  });
  it("org-bound superuser credential with no resolvable org can access nothing", () => {
    expect(canAccessOrg(boundSuperadminNoOrg, "org-a")).toBe(false);
    expect(canAccessOrg(boundSuperadminNoOrg, null)).toBe(false);
  });
});

describe("canAccessUser (MACHINE-2)", () => {
  it("an UNBOUND superadmin reaches any user without a membership lookup", async () => {
    expect(await canAccessUser(superadmin, "u1")).toBe(true);
    expect(membershipTakeFirst).not.toHaveBeenCalled();
  });

  it("an org-bound superuser credential must prove a membership in its bound org", async () => {
    // The target holds no membership in org-a → 404 at every `[id]` user route.
    membershipTakeFirst.mockResolvedValue(undefined);
    expect(await canAccessUser(boundSuperadmin, "u1")).toBe(false);
    expect(membershipTakeFirst).toHaveBeenCalled();
  });

  it("an org-bound superuser credential still reaches its OWN org's members", async () => {
    membershipTakeFirst.mockResolvedValue({ id: "m-1" });
    expect(await canAccessUser(boundSuperadmin, "u1")).toBe(true);
  });

  it("an org-bound credential with no resolvable org reaches nobody", async () => {
    expect(await canAccessUser(boundSuperadminNoOrg, "u1")).toBe(false);
    expect(membershipTakeFirst).not.toHaveBeenCalled();
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
