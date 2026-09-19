import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// access-scope.server imports `db` (for the membership helpers). The pure
// decision functions never touch it; the membership helpers run a single
// `.select().where().where().limit().executeTakeFirst()` we route to a fn.
const membershipTakeFirst = vi.fn();
// `activeGlobalSuperuserGrants` (REVOKE-2) is the one helper here that reads a
// LIST rather than a single row, so the stub routes `.execute()` separately.
const grantsExecute = vi.fn();
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => {
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "executeTakeFirst") return membershipTakeFirst;
            if (prop === "execute") return grantsExecute;
            return () => chain;
          },
        },
      );
      return chain;
    },
  },
}));

import {
  activeGlobalSuperuserGrants,
  canAccessUser,
  hasCrossOrgReach,
  isOrgBound,
  isSuperadmin,
  ownerOutranksActor,
  resolveOrgScope,
  canAccessOrg,
  requiresSuperadminForSharedTarget,
  stripsLastGlobalSuperuser,
  userHasMembershipOutsideOrg,
  wouldStripLastGlobalSuperuser,
  SUPERADMIN_PERMISSION,
  type OrgScope,
  type SuperuserGrant,
} from "@/lib/admin/access-scope.server";

beforeEach(() => {
  membershipTakeFirst.mockReset();
  grantsExecute.mockReset();
  grantsExecute.mockResolvedValue([]);
});
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
    expect(ownerOutranksActor(true, orgAdmin, null)).toBe(true);
  });
  it("allows a COOKIE superadmin actor to mint for a superuser owner", () => {
    expect(ownerOutranksActor(true, superadmin, null)).toBe(false);
  });
  it("refuses a superuser-OWNED BEARER credential, whatever its scopes (P1-1)", () => {
    // `access.permissions` is the OWNER's held set, not the credential's
    // authority. A superuser-owned key scoped to only `admin.apikeys.manage`
    // must not inherit the actor exemption and reissue a broadly-scoped
    // superuser-owned credential in its bound org.
    expect(ownerOutranksActor(true, superadmin, ["admin.apikeys.manage"])).toBe(true);
    expect(ownerOutranksActor(true, boundSuperadmin, ["admin.apikeys.manage"])).toBe(true);
    // Even a full-scope bearer credential: only a cookie session carries the
    // human's own authority.
    expect(ownerOutranksActor(true, boundSuperadmin, ["admin.*"])).toBe(true);
  });
  it("is irrelevant for an ordinary owner", () => {
    expect(ownerOutranksActor(false, orgAdmin, null)).toBe(false);
    expect(ownerOutranksActor(false, superadmin, null)).toBe(false);
    expect(ownerOutranksActor(false, orgAdmin, ["admin.apikeys.manage"])).toBe(false);
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

/**
 * REVOKE-2 — the last-superadmin invariant, tested as the pure rule it is.
 *
 * `stripsLastGlobalSuperuser` is the single predicate all four revocation
 * paths consult (role-assignment delete, role-permission strip, membership
 * PATCH away from active, membership DELETE), so the rule itself is pinned
 * here once rather than re-derived per route.
 */
describe("stripsLastGlobalSuperuser (REVOKE-2)", () => {
  const g1: SuperuserGrant = { appUserId: "u1", organizationId: "org-a", roleId: "r-super" };
  const g2: SuperuserGrant = { appUserId: "u2", organizationId: "org-b", roleId: "r-other" };

  it("is false when there are NO grants — nothing to protect, never a dead-lock", () => {
    // The load-bearing escape hatch: a platform whose superuser is conferred
    // through a GROUP (which `userIsGlobalSuperuser` does not count) must not
    // have every role edit and every membership change refused forever.
    expect(stripsLastGlobalSuperuser([], { roleIds: ["r-super"] })).toBe(false);
  });

  it("is false while one grant survives the removal", () => {
    expect(stripsLastGlobalSuperuser([g1, g2], { assignments: [g1] })).toBe(false);
  });

  it("is true when the removal destroys the only grant", () => {
    expect(stripsLastGlobalSuperuser([g1], { assignments: [g1] })).toBe(true);
  });

  it("is false when the removed assignment differs in ANY of the three keys", () => {
    expect(stripsLastGlobalSuperuser([g1], { assignments: [{ ...g1, roleId: "other" }] })).toBe(
      false,
    );
    expect(stripsLastGlobalSuperuser([g1], { assignments: [{ ...g1, appUserId: "u9" }] })).toBe(
      false,
    );
    expect(
      stripsLastGlobalSuperuser([g1], { assignments: [{ ...g1, organizationId: "org-z" }] }),
    ).toBe(false);
  });

  it("a role strip kills EVERY grant conferred through that role", () => {
    const sameRole: SuperuserGrant = { ...g2, roleId: "r-super" };
    expect(stripsLastGlobalSuperuser([g1, sameRole], { roleIds: ["r-super"] })).toBe(true);
    expect(stripsLastGlobalSuperuser([g1, g2], { roleIds: ["r-other"] })).toBe(false);
  });

  it("a membership removal kills every grant held in that (user, org)", () => {
    expect(
      stripsLastGlobalSuperuser([g1], {
        memberships: [{ appUserId: "u1", organizationId: "org-a" }],
      }),
    ).toBe(true);
    // Same user, DIFFERENT org: the grant in org-a is untouched.
    expect(
      stripsLastGlobalSuperuser([g1], {
        memberships: [{ appUserId: "u1", organizationId: "org-b" }],
      }),
    ).toBe(false);
  });

  it("an empty removal never strips anything", () => {
    expect(stripsLastGlobalSuperuser([g1], {})).toBe(false);
  });
});

describe("activeGlobalSuperuserGrants / wouldStripLastGlobalSuperuser (REVOKE-2)", () => {
  it("maps the DB rows onto the grant shape", async () => {
    grantsExecute.mockResolvedValue([
      { app_user_id: "u1", organization_id: "org-a", role_id: "r-super" },
    ]);
    await expect(activeGlobalSuperuserGrants()).resolves.toEqual([
      { appUserId: "u1", organizationId: "org-a", roleId: "r-super" },
    ]);
  });

  it("feeds those grants to the pure rule", async () => {
    grantsExecute.mockResolvedValue([
      { app_user_id: "u1", organization_id: "org-a", role_id: "r-super" },
    ]);
    await expect(wouldStripLastGlobalSuperuser({ roleIds: ["r-super"] })).resolves.toBe(true);
    await expect(wouldStripLastGlobalSuperuser({ roleIds: ["r-other"] })).resolves.toBe(false);
  });
});
