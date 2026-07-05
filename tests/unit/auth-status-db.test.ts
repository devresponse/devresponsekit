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
const membershipTakeFirst = vi.fn(); // fallback: .where().orderBy().executeTakeFirst()
const membershipByOrgTakeFirst = vi.fn(); // active-org: .where().where().executeTakeFirst()
const rolesExecute = vi.fn();
const readActiveOrgId = vi.fn();
const userIsGlobalSuperuser = vi.fn();

vi.mock("@/lib/active-org.server", () => ({
  readActiveOrgId: () => readActiveOrgId(),
}));
vi.mock("@/lib/admin/access-scope.server", () => ({
  userIsGlobalSuperuser: () => userIsGlobalSuperuser(),
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
      if (table === "app_organization_memberships") {
        return {
          select: () => ({
            where: () => ({
              // cookie-scoped: .where("organization_id","=",activeOrgId).executeTakeFirst()
              where: () => ({ executeTakeFirst: membershipByOrgTakeFirst }),
              // fallback: .orderBy("created_at","asc").executeTakeFirst()
              orderBy: () => ({ executeTakeFirst: membershipTakeFirst }),
            }),
          }),
        };
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
});
