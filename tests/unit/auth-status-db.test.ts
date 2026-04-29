import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * Unit tests for `auth-status.ts > getUserAccessContext` with a mocked
 * Kysely database. Covers the three documented branches:
 *   - user not provisioned → synthetic pending_approval context
 *   - provisioned with no membership → permissions empty, status preserved
 *   - provisioned with membership + roles → permissions populated
 */

const userTakeFirst = vi.fn();
const membershipTakeFirst = vi.fn();
const rolesExecute = vi.fn();

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
  rolesExecute.mockReset();
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
});
