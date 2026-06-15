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

vi.mock("@/lib/active-org.server", () => ({
  readActiveOrgId: () => readActiveOrgId(),
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
      // app_user_roles join chain
      return {
        innerJoin: () => ({
          innerJoin: () => ({
            select: () => ({
              where: () => ({ where: () => ({ execute: rolesExecute }) }),
            }),
          }),
        }),
      };
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

  it("populates permissions from the role join when the user has a membership", async () => {
    userTakeFirst.mockResolvedValue({
      id: "u-1",
      primary_email: "u@x.com",
      status: "active",
      preferred_locale: "en",
    });
    membershipTakeFirst.mockResolvedValue({ organization_id: "o-1", status: "active" });
    rolesExecute.mockResolvedValue([{ key: "shell.view" }, { key: "audit.view" }]);

    const ctx = await getUserAccessContext("ba-1");
    expect(ctx.organizationId).toBe("o-1");
    expect(ctx.membershipStatus).toBe("active");
    expect(ctx.permissions).toEqual(["shell.view", "audit.view"]);
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
    expect(ctx.permissions).toEqual(["admin.users.read"]);
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
});
