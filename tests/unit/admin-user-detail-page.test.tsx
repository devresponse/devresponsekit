import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PageModule from "@/app/[locale]/(secure)/app/administrator/users/[userId]/page";

/**
 * Executes the administrator User-detail RSC (review #122).
 *
 * The page does its own tenant authorization — `canAccessUser(access, id)`
 * → `notFound()` — and, being excluded from unit coverage and imported by
 * no test, that branch had only the static scan in
 * admin-route-scope-invariant.test.ts standing behind it. This suite runs
 * the real server component with `next/navigation.notFound` mocked to throw
 * a sentinel (Next itself throws a special error there) and asserts the
 * ORDER of the gates: permission → id shape → row → tenant scope → render.
 * The HTTP-level 404 (status code, not "a page loaded") is asserted by the
 * Playwright suite; this pins the decision that produces it.
 */
const NOT_FOUND = "__NOT_FOUND_SENTINEL__";
const notFoundMock = vi.fn(() => {
  throw new Error(NOT_FOUND);
});
const checkAdminPermissionServer = vi.fn();
const canAccessUser = vi.fn();
const executeTakeFirst = vi.fn();
const getTranslations = vi.fn();

vi.mock("next/navigation", () => ({ notFound: () => notFoundMock() }));
vi.mock("next-intl/server", () => ({
  getTranslations: (...a: unknown[]) => getTranslations(...a),
}));
vi.mock("@/lib/admin/permissions.server", () => ({
  checkAdminPermissionServer: (...a: unknown[]) => checkAdminPermissionServer(...a),
}));
vi.mock("@/lib/admin/access-scope.server", () => ({
  canAccessUser: (...a: unknown[]) => canAccessUser(...a),
}));
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: () => executeTakeFirst() }),
      }),
    }),
  },
}));
// Client islands: the page only forwards props; they are not under test.
vi.mock("@/app/[locale]/(secure)/app/administrator/users/[userId]/_impersonate-button", () => ({
  ImpersonateUserButton: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-detail-tabs", () => ({
  UserDetailTabs: () => null,
}));
vi.mock("@/components/ui/status-badge", () => ({ StatusBadge: () => null }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS = {
  appUserId: "admin-app-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.users.read"],
};
const USER_ROW = {
  id: USER_ID,
  better_auth_user_id: "ba-target",
  primary_email: "target@x.com",
  display_name: null,
  status: "active",
  status_reason: null,
  preferred_locale: "en",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-02T00:00:00Z"),
  deactivated_at: null,
  deactivated_by: null,
  deactivated_reason: null,
};

let Page: typeof PageModule.default;

function params(userId: string) {
  return { params: Promise.resolve({ locale: "en", userId }) };
}

beforeEach(async () => {
  for (const m of [checkAdminPermissionServer, canAccessUser, executeTakeFirst, getTranslations])
    m.mockReset();
  notFoundMock.mockClear();
  checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-admin", access: ACCESS });
  executeTakeFirst.mockResolvedValue(USER_ROW);
  getTranslations.mockResolvedValue((key: string) => key);
  ({ default: Page } =
    await import("@/app/[locale]/(secure)/app/administrator/users/[userId]/page"));
});
afterEach(() => vi.resetModules());

describe("administrator/users/[userId] page — tenant scope (ADR-0001, review #122)", () => {
  it("calls notFound() when canAccessUser is false, before translating or rendering", async () => {
    canAccessUser.mockResolvedValue(false);
    await expect(Page(params(USER_ID))).rejects.toThrow(NOT_FOUND);
    expect(notFoundMock).toHaveBeenCalledTimes(1);
    // The scope check receives the CALLER'S access context and the target row id.
    expect(canAccessUser).toHaveBeenCalledWith(ACCESS, USER_ID);
    // Nothing past the gate ran: no translation load, hence no render.
    expect(getTranslations).not.toHaveBeenCalled();
  });

  it("renders when canAccessUser is true (the gate is the only thing between the row and the page)", async () => {
    canAccessUser.mockResolvedValue(true);
    const element = await Page(params(USER_ID));
    expect(element).toBeTruthy();
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(getTranslations).toHaveBeenCalledWith({
      locale: "en",
      namespace: "administrator.users",
    });
  });

  it("calls notFound() for a missing row WITHOUT consulting the scope check (existence stays indistinguishable)", async () => {
    executeTakeFirst.mockResolvedValue(undefined);
    await expect(Page(params(USER_ID))).rejects.toThrow(NOT_FOUND);
    expect(canAccessUser).not.toHaveBeenCalled();
  });

  it("calls notFound() for a non-UUID id before touching the database", async () => {
    await expect(Page(params("not-a-uuid"))).rejects.toThrow(NOT_FOUND);
    expect(executeTakeFirst).not.toHaveBeenCalled();
    expect(canAccessUser).not.toHaveBeenCalled();
  });

  /**
   * Review #212 — `deactivated_by` stores the actor's BETTER AUTH id, which
   * the Overview tab rendered verbatim ("Deactivated by ba-admin-7"). The
   * RSC now resolves it to a display name, falling back to the raw id.
   *
   * The resolution is ORG-SCOPED: ADR-0001 allows a user to hold several
   * memberships, so a target an Org A admin may read can have been
   * deactivated by an Org B admin (or a platform superadmin). Resolving that
   * actor's name/email unconditionally would be a cross-tenant PII leak, so
   * the actor row goes through the same `canAccessUser` predicate as the
   * target, with a self-exemption for the caller.
   */
  describe("deactivated_by resolution (review #212)", () => {
    /** Depth-first search for the `user` prop handed to UserDetailTabs. */
    function findUserProp(node: unknown): Record<string, unknown> | undefined {
      if (!node || typeof node !== "object") return undefined;
      const el = node as { props?: Record<string, unknown> };
      const user = el.props?.user;
      if (user && typeof user === "object") return user as Record<string, unknown>;
      const children = el.props?.children;
      for (const child of Array.isArray(children) ? children : [children]) {
        const found = findUserProp(child);
        if (found) return found;
      }
      return undefined;
    }

    beforeEach(() => canAccessUser.mockResolvedValue(true));

    it("resolves the actor id to a display name", async () => {
      executeTakeFirst
        .mockResolvedValueOnce({ ...USER_ROW, deactivated_by: "ba-admin-7" })
        .mockResolvedValueOnce({
          id: "actor-app-7",
          display_name: "Grace Hopper",
          primary_email: "grace@x.com",
        });

      const user = findUserProp(await Page(params(USER_ID)))!;
      expect(user.deactivated_by).toBe("ba-admin-7");
      expect(user.deactivated_by_label).toBe("Grace Hopper");
    });

    it("falls back to the actor's email, then to the raw id", async () => {
      executeTakeFirst
        .mockResolvedValueOnce({ ...USER_ROW, deactivated_by: "ba-admin-7" })
        .mockResolvedValueOnce({
          id: "actor-app-7",
          display_name: null,
          primary_email: "grace@x.com",
        });
      expect(findUserProp(await Page(params(USER_ID)))!.deactivated_by_label).toBe("grace@x.com");

      executeTakeFirst
        .mockResolvedValueOnce({ ...USER_ROW, deactivated_by: "ba-ghost" })
        .mockResolvedValueOnce(undefined);
      expect(findUserProp(await Page(params(USER_ID)))!.deactivated_by_label).toBe("ba-ghost");
    });

    it("keeps an out-of-scope actor's name off the page — raw id only (ADR-0001)", async () => {
      // Target is visible to this org admin; the actor who deactivated them
      // is NOT (another tenant's admin, or a platform superadmin).
      canAccessUser.mockReset();
      canAccessUser.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      executeTakeFirst
        .mockResolvedValueOnce({ ...USER_ROW, deactivated_by: "ba-org-b-admin" })
        .mockResolvedValueOnce({
          id: "actor-app-9",
          display_name: "Org B Admin",
          primary_email: "admin@org-b.example",
        });

      const user = findUserProp(await Page(params(USER_ID)))!;
      expect(user.deactivated_by_label).toBe("ba-org-b-admin");
      // No trace of the other tenant's PII anywhere in the client payload.
      expect(JSON.stringify(user)).not.toMatch(/Org B Admin|admin@org-b\.example/);
      // The actor row went through the SAME tenant predicate as the target.
      expect(canAccessUser).toHaveBeenNthCalledWith(2, ACCESS, "actor-app-9");
    });

    it("resolves the caller's own name without a second scope query", async () => {
      // Self-exemption: the actor IS the caller, so no membership lookup is
      // needed. Only one `canAccessUser` answer is queued — a second call
      // would resolve `undefined` and collapse the label to the raw id.
      canAccessUser.mockReset();
      canAccessUser.mockResolvedValueOnce(true);
      executeTakeFirst
        .mockResolvedValueOnce({ ...USER_ROW, deactivated_by: "ba-admin" })
        .mockResolvedValueOnce({
          id: "admin-app-1",
          display_name: "Ada Admin",
          primary_email: "admin@x.com",
        });

      expect(findUserProp(await Page(params(USER_ID)))!.deactivated_by_label).toBe("Ada Admin");
      expect(canAccessUser).toHaveBeenCalledTimes(1);
    });

    it("does not run the lookup when the user was never deactivated", async () => {
      executeTakeFirst.mockReset();
      executeTakeFirst.mockResolvedValue(USER_ROW); // deactivated_by is null
      const user = findUserProp(await Page(params(USER_ID)))!;
      expect(user.deactivated_by_label).toBeNull();
      expect(executeTakeFirst).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["denied", "unauthenticated"] as const)(
    "calls notFound() when the permission guard returns %s, before any read",
    async (verdict) => {
      checkAdminPermissionServer.mockResolvedValue(verdict);
      await expect(Page(params(USER_ID))).rejects.toThrow(NOT_FOUND);
      expect(checkAdminPermissionServer).toHaveBeenCalledWith("admin.users.read");
      expect(executeTakeFirst).not.toHaveBeenCalled();
      expect(canAccessUser).not.toHaveBeenCalled();
    },
  );
});
