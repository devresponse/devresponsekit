import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * Unit tests for `auth-status.ts > getUserAccessContext` with a mocked
 * Kysely database. Covers:
 *   - user not provisioned → synthetic pending_approval context
 *   - provisioned with no membership → permissions empty, status preserved
 *   - provisioned with membership + roles → permissions populated
 *   - multi-org: the `active_org` cookie selects the membership, and a stale
 *     cookie falls back to the earliest membership.
 */

const userTakeFirst = vi.fn();
const membershipTakeFirst = vi.fn(); // fallback: …orderBy("created_at").executeTakeFirst()
const membershipByOrgTakeFirst = vi.fn(); // active-org: …where(org).executeTakeFirst()
const rolesExecute = vi.fn();
const readActiveOrgId = vi.fn();
const userIsGlobalSuperuser = vi.fn();
const listActiveOrganizationIdsForBetterAuthUser = vi.fn();
/**
 * IMP-2: the confinement asks whether the IMPERSONATOR is an unbound global
 * superuser before it measures their tenancy by membership — a superadmin's
 * reach is conferred by permission, not by membership rows.
 */
const betterAuthUserIsGlobalSuperuser = vi.fn();
/** Every `.where(...)` argument list the membership builder received. */
const membershipWheres: unknown[][] = [];
/**
 * One entry per membership LOOKUP (per `selectFrom`), recording its joins and
 * predicates separately, so a test can assert that EACH lookup — the cookie
 * hit, the fallback, the bound-org read — carries the F-09 organization-status
 * predicate, not merely that one of them did.
 */
const membershipLookups: { table: string; joins: unknown[][]; wheres: unknown[][] }[] = [];

vi.mock("@/lib/active-org.server", () => ({
  readActiveOrgId: () => readActiveOrgId(),
  listActiveOrganizationIdsForBetterAuthUser: (...a: unknown[]) =>
    listActiveOrganizationIdsForBetterAuthUser(...a),
}));
vi.mock("@/lib/admin/access-scope.server", () => ({
  userIsGlobalSuperuser: () => userIsGlobalSuperuser(),
  betterAuthUserIsGlobalSuperuser: (...a: unknown[]) => betterAuthUserIsGlobalSuperuser(...a),
}));
// F-08: the confinement also asks whether the impersonator is BANNED in Better
// Auth; nobody is here (the ban itself is pinned in impersonation-reach.test).
vi.mock("@/lib/api-auth/ban-status.server", () => ({
  isBetterAuthUserBanned: async () => false,
}));

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) => {
      if (table === "app_users") {
        return {
          select: () => ({
            where: () => ({ executeTakeFirst: userTakeFirst }),
          }),
        };
      }
      if (table.startsWith("app_organization_memberships")) {
        // A chainable recorder rather than a fixed shape: since IMP-1 the
        // membership lookup may carry an EXTRA `where("m.organization_id","in",…)`
        // confinement predicate, so the number of `.where` links is no longer
        // fixed. The two terminal fakes are told apart by whether `.orderBy`
        // ran — that is exactly what distinguishes the earliest-membership
        // fallback from the active-org lookup. (Matched by prefix: since F-09
        // the lookup is aliased `as m` to join `app_organizations as o`.)
        let ordered = false;
        const lookup = { table, joins: [] as unknown[][], wheres: [] as unknown[][] };
        membershipLookups.push(lookup);
        const chain: unknown = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "executeTakeFirst") {
                return ordered ? membershipTakeFirst : membershipByOrgTakeFirst;
              }
              if (prop === "orderBy") {
                return () => {
                  ordered = true;
                  return chain;
                };
              }
              if (prop === "where") {
                return (...args: unknown[]) => {
                  membershipWheres.push(args);
                  lookup.wheres.push(args);
                  return chain;
                };
              }
              if (prop === "innerJoin") {
                return (...args: unknown[]) => {
                  lookup.joins.push(args);
                  return chain;
                };
              }
              return () => chain;
            },
          },
        );
        return chain;
      }
      // Permission-resolution chains: the direct (app_user_roles) and
      // group (app_group_memberships) builders feed a UNION; only the left
      // builder's `.execute()` runs. A generic proxy handles any method chain
      // (innerJoin/select/where/union) and routes `.execute` to rolesExecute.
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "execute") return rolesExecute;
            return () => chain;
          },
        },
      );
      return chain;
    },
  },
}));

let getUserAccessContext: typeof AuthStatusModule.getUserAccessContext;

beforeEach(async () => {
  userTakeFirst.mockReset();
  membershipTakeFirst.mockReset();
  membershipByOrgTakeFirst.mockReset();
  rolesExecute.mockReset();
  readActiveOrgId.mockReset();
  readActiveOrgId.mockResolvedValue(null); // no active-org cookie by default
  userIsGlobalSuperuser.mockReset();
  userIsGlobalSuperuser.mockResolvedValue(false); // not a global superuser by default
  listActiveOrganizationIdsForBetterAuthUser.mockReset();
  betterAuthUserIsGlobalSuperuser.mockReset();
  betterAuthUserIsGlobalSuperuser.mockResolvedValue(false); // an ordinary admin by default
  membershipWheres.length = 0;
  membershipLookups.length = 0;
  ({ getUserAccessContext } = await import("@/lib/auth-status"));
});
afterEach(() => vi.resetModules());

describe("getUserAccessContext (DB-backed)", () => {
  it("returns a synthetic pending_approval context when the user is not provisioned", async () => {
    userTakeFirst.mockResolvedValue(undefined);
    const ctx = await getUserAccessContext("ba-1");
    expect(ctx).toEqual({
      appUserId: null,
      primaryEmail: null,
      status: "pending_approval",
      organizationId: null,
      membershipStatus: null,
      preferredLocale: "en",
      permissions: [],
      // MACHINE-2: set explicitly even on this short-circuit — the marker
      // records HOW the caller presented itself (no `boundOrg` → a session).
      orgBound: false,
    });
    expect(membershipTakeFirst).not.toHaveBeenCalled();
  });

  it("returns context with empty permissions when the user has no membership", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "fr",
    });
    membershipTakeFirst.mockResolvedValue(undefined);

    const ctx = await getUserAccessContext("ba-1");
    expect(ctx).toMatchObject({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: null,
      membershipStatus: null,
      preferredLocale: "fr",
      permissions: [],
    });
    expect(rolesExecute).not.toHaveBeenCalled();
  });

  it("populates permissions from the effective-role (direct ∪ group) join when the user has a membership", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-1", status: "active" });
    // The UNION query (ADR-0002) returns the deduplicated key set.
    rolesExecute.mockResolvedValue([{ key: "shell.view" }, { key: "audit.view" }]);

    const ctx = await getUserAccessContext("ba-1");
    expect(ctx.organizationId).toBe("o-1");
    expect(ctx.membershipStatus).toBe("active");
    expect(ctx.permissions).toEqual(["shell.view", "audit.view"]);
  });

  it("includes a permission reachable ONLY through a group (no direct role grants it)", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-1", status: "active" });
    // Effective set = direct (shell.view) ∪ via-group (admin.users.read).
    rolesExecute.mockResolvedValue([{ key: "shell.view" }, { key: "admin.users.read" }]);

    const ctx = await getUserAccessContext("ba-1");
    expect(ctx.permissions).toContain("admin.users.read");
  });

  it("deduplicates a permission granted by BOTH a direct role and a group", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-1", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "admin.users.read" }, { key: "admin.users.read" }]);

    const ctx = await getUserAccessContext("ba-1");
    // An active member always carries the baseline `shell.view` (implied by
    // membership), in addition to whatever their roles grant.
    expect(ctx.permissions).toEqual(["admin.users.read", "shell.view"]);
  });

  it("grants the baseline shell.view to an active member who holds NO role (self-registered member)", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-1", status: "active" });
    // The exact self-registration case: an active membership, but no role or
    // group grants anything — the union returns nothing.
    rolesExecute.mockResolvedValue([]);

    const ctx = await getUserAccessContext("ba-1");
    // Still gets shell.view so the shell nav (Dashboard, Account) is visible.
    expect(ctx.permissions).toEqual(["shell.view"]);
  });

  it("does NOT grant shell.view when the membership is not active (pending member)", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-1", status: "pending_approval" });
    rolesExecute.mockResolvedValue([]);

    const ctx = await getUserAccessContext("ba-1");
    // secure access is not "allow" for a pending membership → no baseline.
    expect(ctx.permissions).toEqual([]);
  });

  it("selects the org named by the active_org cookie (not the earliest)", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    readActiveOrgId.mockResolvedValue("o-cookie");
    membershipByOrgTakeFirst.mockResolvedValue({ organization_id: "o-cookie", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "admin.users.read" }]);

    const ctx = await getUserAccessContext("ba-1");
    expect(ctx.organizationId).toBe("o-cookie");
    // MACHINE-2: the cookie/session path is NOT bound — a human superadmin at a
    // browser keeps cross-org reach.
    expect(ctx.orgBound).toBe(false);
    // An active member always carries the baseline `shell.view` (implied by
    // membership), in addition to whatever their roles grant.
    expect(ctx.permissions).toEqual(["admin.users.read", "shell.view"]);
    // The fallback (earliest-membership) query must NOT run when the cookie hits.
    expect(membershipTakeFirst).not.toHaveBeenCalled();
  });

  it("falls back to the earliest membership when the cookie names an org the user is not in", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    readActiveOrgId.mockResolvedValue("o-stale");
    membershipByOrgTakeFirst.mockResolvedValue(undefined); // not an active member there
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-earliest", status: "active" });
    rolesExecute.mockResolvedValue([]);

    const ctx = await getUserAccessContext("ba-1");
    expect(membershipByOrgTakeFirst).toHaveBeenCalled();
    expect(ctx.organizationId).toBe("o-earliest");
  });

  it("grants the full superuser set to a global superuser even when the active org grants none", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "su@x.com",
      status: "active",
      preferred_locale: "en",
    });
    // Active org is one where they're only a plain member (no admin perms)…
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-member", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "shell.view" }]);
    // …but they hold the superuser marker in some other active membership.
    userIsGlobalSuperuser.mockResolvedValue(true);

    const ctx = await getUserAccessContext("ba-1");
    // Recognized as a superadmin everywhere, with the full admin authority.
    expect(ctx.orgBound).toBe(false);
    expect(ctx.permissions).toContain("superuser");
    expect(ctx.permissions).toContain("admin.users.read");
    expect(ctx.permissions).toContain("admin.audit.read");
  });

  it("bearer bound-org: resolves the credential's org and ignores the active_org cookie (MACHINE-1)", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    // A cookie is present but must be ignored on the bearer path.
    readActiveOrgId.mockResolvedValue("o-cookie");
    membershipByOrgTakeFirst.mockResolvedValue({ organization_id: "o-bound", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "admin.users.read" }]);

    const ctx = await getUserAccessContext("ba-1", { organizationId: "o-bound" });
    expect(ctx.organizationId).toBe("o-bound");
    // MACHINE-2: the marker that lets the scope helpers cap this context.
    expect(ctx.orgBound).toBe(true);
    // An active member always carries the baseline `shell.view` (implied by
    // membership), in addition to whatever their roles grant.
    expect(ctx.permissions).toEqual(["admin.users.read", "shell.view"]);
    expect(readActiveOrgId).not.toHaveBeenCalled();
    expect(membershipTakeFirst).not.toHaveBeenCalled();
  });

  it("bearer bound-org: a non-member bound org yields no membership / no permissions (fails closed)", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    membershipByOrgTakeFirst.mockResolvedValue(undefined); // not an active member of the bound org

    const ctx = await getUserAccessContext("ba-1", { organizationId: "o-foreign" });
    expect(ctx.organizationId).toBeNull();
    // MACHINE-2: still bound — `resolveOrgScope` must answer null (deny), not
    // "all", for a bound credential that resolved to no membership.
    expect(ctx.orgBound).toBe(true);
    expect(ctx.membershipStatus).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(rolesExecute).not.toHaveBeenCalled();
    expect(readActiveOrgId).not.toHaveBeenCalled();
  });

  it("bearer bound-org: a null bound org (org-less credential) uses the earliest membership, not the cookie", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    readActiveOrgId.mockResolvedValue("o-cookie");
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-earliest", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "shell.view" }]);

    const ctx = await getUserAccessContext("ba-1", { organizationId: null });
    expect(ctx.organizationId).toBe("o-earliest");
    // MACHINE-2: an ORG-LESS credential is still a credential — it is bound to
    // whatever single membership resolved, never to "every org".
    expect(ctx.orgBound).toBe(true);
    expect(membershipByOrgTakeFirst).not.toHaveBeenCalled();
    expect(readActiveOrgId).not.toHaveBeenCalled();
  });

  it("expands a BARE `superuser` role (marker only) to the full admin set, without a DB lookup", async () => {
    // The dev seed's per-org `superuser` role grants ONLY `shell.view` +
    // `superuser` — not the individual admin.* keys. Such an account must
    // still resolve to the full superuser authority, or every per-feature
    // `permissions.includes("admin.*")` check (RSC `canX` toggles, the
    // server-filtered nav) treats them as a plain user. (Regression: the old
    // code skipped the expansion whenever the marker was already present.)
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "superuser@orga.local",
      status: "active",
      preferred_locale: "en",
    });
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-a", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "shell.view" }, { key: "superuser" }]);

    const ctx = await getUserAccessContext("ba-1");
    expect(ctx.permissions).toContain("superuser");
    expect(ctx.permissions).toContain("admin.users.read");
    expect(ctx.permissions).toContain("admin.orgs.update");
    // The marker is already present, so the redundant lookup is skipped.
    expect(userIsGlobalSuperuser).not.toHaveBeenCalled();
  });

  it("MACHINE-2: a GLOBAL superuser on the bound-org path keeps the full permission set AND is marked org-bound", async () => {
    // This is the exact shape of the vulnerability: a credential minted in
    // org-a whose owner is a global superuser. The permission EXPANSION must
    // still happen (dropping it would turn a scoping bug into an
    // authentication bug — every `permissions.includes("admin.*")` gate would
    // start failing for a legitimate bound superuser), so the ONLY thing that
    // stops the credential reaching org-b is the `orgBound` marker travelling
    // with it to `resolveOrgScope` / `canAccessOrg` / `canAccessUser`.
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "su@x.com",
      status: "active",
      preferred_locale: "en",
    });
    membershipByOrgTakeFirst.mockResolvedValue({ organization_id: "o-a", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "shell.view" }]);
    userIsGlobalSuperuser.mockResolvedValue(true);

    const ctx = await getUserAccessContext("ba-1", { organizationId: "o-a" });
    expect(ctx.orgBound).toBe(true);
    expect(ctx.organizationId).toBe("o-a");
    expect(ctx.permissions).toContain("superuser");
    expect(ctx.permissions).toContain("admin.users.read");
  });

  /* ---------------------------------------------------------------------- */
  /*  IMP-1 — impersonation tenant confinement                               */
  /* ---------------------------------------------------------------------- */

  const ACTIVE_USER = {
    id: "u-target",
    primary_email: "target@x.com",
    status: "active",
    preferred_locale: "en",
  };

  it("IMP-1: confines an impersonated session to orgs the IMPERSONATOR is an active member of", async () => {
    // The shape of the vulnerability: the target is a member of org-a (shared
    // with the admin) AND org-b (the admin is NOT in org-b), and the admin has
    // rewritten the unsigned active_org cookie to org-b. The cookie lookup must
    // carry the impersonator's org set as a predicate, so org-b can never be
    // selected — not because the cookie is unreadable, but because the query
    // cannot return a row outside the intersection.
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-b");
    listActiveOrganizationIdsForBetterAuthUser.mockResolvedValue(["o-a"]);
    membershipByOrgTakeFirst.mockResolvedValue(undefined); // no row inside the intersection
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-a", status: "active" });
    rolesExecute.mockResolvedValue([]);

    const ctx = await getUserAccessContext("ba-target", undefined, {
      betterAuthUserId: "ba-admin",
    });

    expect(listActiveOrganizationIdsForBetterAuthUser).toHaveBeenCalledWith("ba-admin");
    // The confinement predicate reached BOTH the cookie lookup and the
    // earliest-membership fallback — a fallback that skipped it would still
    // land the session in a foreign tenant.
    const confinements = membershipWheres.filter((w) => w[1] === "in");
    expect(confinements).toHaveLength(2);
    expect(confinements[0]).toEqual(["m.organization_id", "in", ["o-a"]]);
    expect(confinements[1]).toEqual(["m.organization_id", "in", ["o-a"]]);
    // …and the cookie's org was still asked for, so this is the confinement
    // biting rather than the cookie being ignored.
    expect(membershipWheres).toContainEqual(["m.organization_id", "=", "o-b"]);
    expect(ctx.organizationId).toBe("o-a");
  });

  it("IMP-1: an impersonated session still resolves an org SHARED with the impersonator", async () => {
    // The control. Ordinary impersonation — the admin and the target share
    // org-a and the cookie names org-a — must keep working exactly as before,
    // permissions and all, or the fix has simply broken the feature.
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-a");
    listActiveOrganizationIdsForBetterAuthUser.mockResolvedValue(["o-a", "o-c"]);
    membershipByOrgTakeFirst.mockResolvedValue({ organization_id: "o-a", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "admin.users.read" }]);

    const ctx = await getUserAccessContext("ba-target", undefined, {
      betterAuthUserId: "ba-admin",
    });

    expect(ctx.organizationId).toBe("o-a");
    expect(ctx.permissions).toEqual(["admin.users.read", "shell.view"]);
    expect(membershipTakeFirst).not.toHaveBeenCalled();
    // A borrowed cookie session is NOT a bearer credential, so it keeps the
    // unbound marker — the confinement is a membership rule, not MACHINE-2.
    expect(ctx.orgBound).toBe(false);
  });

  it("IMP-1: fails closed when the impersonator holds no active membership anywhere", async () => {
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-b");
    listActiveOrganizationIdsForBetterAuthUser.mockResolvedValue([]);

    const ctx = await getUserAccessContext("ba-target", undefined, {
      betterAuthUserId: "ba-admin",
    });

    // No org, no membership, no permissions — `decideSecureAccess` then blocks
    // every secure surface. And no membership query ran at all, so an empty
    // `in ()` never reaches SQL.
    expect(ctx.organizationId).toBeNull();
    expect(ctx.membershipStatus).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(membershipWheres).toEqual([]);
    expect(membershipByOrgTakeFirst).not.toHaveBeenCalled();
    expect(membershipTakeFirst).not.toHaveBeenCalled();
    expect(rolesExecute).not.toHaveBeenCalled();
  });

  it("IMP-2: a SUPERADMIN impersonator is UNCONFINED — the target's own tenant resolves", async () => {
    // The platform-support flow the membership intersection broke. A superadmin
    // reaches every tenant AS THEMSELVES (`hasCrossOrgReach` / `canAccessUser`
    // short-circuit on the marker, and creating an organization never enrols
    // the creator), so measuring their reach by membership rows resolved NO
    // org at all: the borrowed session landed on `pending_approval`, every
    // route answered 403, and the admin was stranded on a page outside the
    // secure layout that renders neither the Stop control nor a sign-out.
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-customer");
    betterAuthUserIsGlobalSuperuser.mockResolvedValue(true);
    membershipByOrgTakeFirst.mockResolvedValue({ organization_id: "o-customer", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "admin.users.read" }]);

    const ctx = await getUserAccessContext("ba-target", undefined, {
      betterAuthUserId: "ba-superadmin",
    });

    expect(betterAuthUserIsGlobalSuperuser).toHaveBeenCalledWith("ba-superadmin");
    // Unconfined means the membership query carries NO `in` predicate at all,
    // and the membership list is never even fetched.
    expect(listActiveOrganizationIdsForBetterAuthUser).not.toHaveBeenCalled();
    expect(membershipWheres.some((w) => w[1] === "in")).toBe(false);
    expect(ctx.organizationId).toBe("o-customer");
    expect(ctx.permissions).toContain("admin.users.read");
  });

  it("IMP-2: a NON-superadmin in the same position still fails closed", async () => {
    // The control that keeps the exemption honest: same target, same tenant,
    // an ordinary org admin behind the session — and nothing resolves.
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-customer");
    betterAuthUserIsGlobalSuperuser.mockResolvedValue(false);
    listActiveOrganizationIdsForBetterAuthUser.mockResolvedValue([]); // no shared tenant

    const ctx = await getUserAccessContext("ba-target", undefined, {
      betterAuthUserId: "ba-admin",
    });

    expect(ctx.organizationId).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(membershipWheres).toEqual([]);
  });

  it("IMP-1: a NON-impersonated session is untouched — no confinement lookup, no predicate", async () => {
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-b");
    membershipByOrgTakeFirst.mockResolvedValue({ organization_id: "o-b", status: "active" });
    rolesExecute.mockResolvedValue([]);

    const ctx = await getUserAccessContext("ba-target");

    expect(listActiveOrganizationIdsForBetterAuthUser).not.toHaveBeenCalled();
    // …and the superuser probe on the IMPERSONATOR is not run either: there is
    // no impersonator to probe (IMP-2).
    expect(betterAuthUserIsGlobalSuperuser).not.toHaveBeenCalled();
    expect(membershipWheres.some((w) => w[1] === "in")).toBe(false);
    expect(ctx.organizationId).toBe("o-b");
  });

  /* ---------------------------------------------------------------------- */
  /*  F-09 — organization status is a membership gate                        */
  /* ---------------------------------------------------------------------- */

  /** The F-09 predicate, exactly as each lookup must carry it. */
  const ORG_ACTIVE_JOIN = ["app_organizations as o", "o.id", "m.organization_id"];
  const ORG_ACTIVE_WHERE = ["o.status", "=", "active"];

  function expectEveryLookupRequiresAnActiveOrg(expectedLookups: number): void {
    expect(membershipLookups).toHaveLength(expectedLookups);
    for (const lookup of membershipLookups) {
      expect(lookup.table).toBe("app_organization_memberships as m");
      expect(lookup.joins).toContainEqual(ORG_ACTIVE_JOIN);
      expect(lookup.wheres).toContainEqual(ORG_ACTIVE_WHERE);
    }
  }

  it("F-09 cookie path: a cookie naming a SUSPENDED org falls through to the earliest ACTIVE-org membership — both lookups require o.status = 'active'", async () => {
    // A member of a suspended tenant and an active one, with the cookie still
    // pointing at the suspended tenant. The cookie lookup finds nothing because
    // its query requires an active org; the fallback lands in the active one.
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-suspended");
    membershipByOrgTakeFirst.mockResolvedValue(undefined);
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-active", status: "active" });
    rolesExecute.mockResolvedValue([]);

    const ctx = await getUserAccessContext("ba-target");

    expectEveryLookupRequiresAnActiveOrg(2);
    expect(membershipWheres).toContainEqual(["m.organization_id", "=", "o-suspended"]);
    expect(ctx.organizationId).toBe("o-active");
  });

  it("F-09 cookie path: a member of ONLY non-active orgs resolves to no membership and is refused — and no superuser grant can promote that context", async () => {
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-suspended");
    membershipByOrgTakeFirst.mockResolvedValue(undefined);
    membershipTakeFirst.mockResolvedValue(undefined);
    userIsGlobalSuperuser.mockResolvedValue(true);

    const ctx = await getUserAccessContext("ba-target");

    expectEveryLookupRequiresAnActiveOrg(2);
    expect(ctx.organizationId).toBeNull();
    expect(ctx.membershipStatus).toBeNull();
    expect(ctx.permissions).toEqual([]);
    // Refused by the one decision every secure surface asks.
    const { decideSecureAccess } = await import("@/lib/auth-status");
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).not.toBe("allow");
    expect(rolesExecute).not.toHaveBeenCalled();
  });

  it("F-09 key/JWT path: a credential BOUND to a suspended org stops authenticating — the bound lookup requires an active org", async () => {
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-active"); // ignored on the bearer path
    membershipByOrgTakeFirst.mockResolvedValue(undefined); // the org is not active
    userIsGlobalSuperuser.mockResolvedValue(true);

    const ctx = await getUserAccessContext("ba-target", { organizationId: "o-suspended" });

    expectEveryLookupRequiresAnActiveOrg(1);
    expect(membershipWheres).toContainEqual(["m.organization_id", "=", "o-suspended"]);
    expect(ctx.orgBound).toBe(true);
    expect(ctx.organizationId).toBeNull();
    expect(ctx.permissions).toEqual([]);
    const { decideSecureAccess } = await import("@/lib/auth-status");
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).not.toBe("allow");
    expect(readActiveOrgId).not.toHaveBeenCalled();
  });

  it("F-09 key/JWT path: an ORG-LESS credential's earliest-membership lookup requires an active org too", async () => {
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-active", status: "active" });
    rolesExecute.mockResolvedValue([]);

    const ctx = await getUserAccessContext("ba-target", { organizationId: null });

    expectEveryLookupRequiresAnActiveOrg(1);
    expect(ctx.organizationId).toBe("o-active");
  });

  it("F-09 impersonation: the confined lookups carry the organization predicate alongside the confinement", async () => {
    userTakeFirst.mockResolvedValue(ACTIVE_USER);
    readActiveOrgId.mockResolvedValue("o-a");
    listActiveOrganizationIdsForBetterAuthUser.mockResolvedValue(["o-a"]);
    membershipByOrgTakeFirst.mockResolvedValue(undefined);
    membershipTakeFirst.mockResolvedValue(undefined);

    await getUserAccessContext("ba-target", undefined, { betterAuthUserId: "ba-admin" });

    expectEveryLookupRequiresAnActiveOrg(2);
    for (const lookup of membershipLookups) {
      expect(lookup.wheres).toContainEqual(["m.organization_id", "in", ["o-a"]]);
    }
  });

  it("MACHINE-2: an UNPROVISIONED user still reports how it presented itself", async () => {
    // The synthetic pending_approval short-circuit returns before any
    // membership lookup; the marker describes the CALLER, not what was found,
    // so it must be set on that path too rather than defaulting to undefined.
    userTakeFirst.mockResolvedValue(undefined);
    expect((await getUserAccessContext("ba-missing")).orgBound).toBe(false);
    expect((await getUserAccessContext("ba-missing", { organizationId: "o-a" })).orgBound).toBe(
      true,
    );
  });
});
