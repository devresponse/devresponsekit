import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PageModule from "@/app/[locale]/(secure)/app/administrator/users/new/page";

/**
 * Executes the administrator New-user RSC (F-13).
 *
 * `POST /api/administrator/users` refuses the Better Auth `role: "admin"`
 * with 403 unless the caller has cross-org reach (`hasCrossOrgReach`, the
 * rule of `POST /users/[id]/role`). The page decides whether the form offers
 * that role, and it must decide with the same predicate, or an org admin is
 * offered a choice whose every submit answers 403. The component suite
 * (tests/component/new-user-form.test.tsx) pins what the form does with the
 * prop; this suite pins the prop the page passes. `hasCrossOrgReach` is the
 * real one. The initial status follows the same rule (F-480): a confined
 * creator's user joins its org, so the API refuses every create from one
 * without `admin.users.update` or `admin.orgs.update`, and an Active one
 * without `admin.users.manage` as well. The page asks the API's own predicate
 * (`mayCreateUser`, real here): it shows a notice in place of a form whose
 * every submit would answer 403, and offers Active only when it may.
 */
const NOT_FOUND = "__NOT_FOUND_SENTINEL__";
const notFoundMock = vi.fn(() => {
  throw new Error(NOT_FOUND);
});
const checkAdminPermissionServer = vi.fn();

vi.mock("next/navigation", () => ({ notFound: () => notFoundMock() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/admin/permissions.server", () => ({
  checkAdminPermissionServer: (...a: unknown[]) => checkAdminPermissionServer(...a),
}));
// access-scope.server imports the database module; the predicate under test
// never queries it.
vi.mock("@/db/database", () => ({ db: {} }));
// The client island: the page only forwards props to it.
vi.mock("@/app/[locale]/(secure)/app/administrator/users/new/_new-user-form", () => ({
  NewUserForm: function NewUserForm() {
    return null;
  },
}));

/** An org admin who may create users: its create is a membership add (F-480). */
const ORG_ADMIN = {
  appUserId: "admin-app-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.users.read", "admin.users.create", "admin.users.update"],
  orgBound: false,
};
const SUPERADMIN = { ...ORG_ADMIN, permissions: [...ORG_ADMIN.permissions, "superuser"] };

let Page: typeof PageModule.default;

beforeEach(async () => {
  checkAdminPermissionServer.mockReset();
  notFoundMock.mockClear();
  ({ default: Page } = await import("@/app/[locale]/(secure)/app/administrator/users/new/page"));
});
afterEach(() => vi.resetModules());

const params = { params: Promise.resolve({ locale: "en" }) };

/** The props the page hands to `NewUserForm`, found in the rendered tree. */
function formProps(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: { name?: string }; props?: Record<string, unknown> };
  if (el.type?.name === "NewUserForm") return el.props ?? null;
  const children = el.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = formProps(child);
    if (found) return found;
  }
  return null;
}

/** Every string rendered in the tree (the mocked translator returns the key). */
function texts(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (!node || typeof node !== "object") return [];
  const children = (node as { props?: { children?: unknown } }).props?.children;
  return (Array.isArray(children) ? children.flat(Infinity) : [children]).flatMap(texts);
}

describe("new-user page — the platform role is offered with the API's predicate (F-13)", () => {
  it("does not offer it to an org admin", async () => {
    checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-1", access: ORG_ADMIN });
    expect(formProps(await Page(params))).toEqual({
      locale: "en",
      canGrantPlatformAdmin: false,
      canCreateActive: false,
    });
    expect(checkAdminPermissionServer).toHaveBeenCalledWith("admin.users.create");
  });

  it("offers it to a superadmin", async () => {
    checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-1", access: SUPERADMIN });
    expect(formProps(await Page(params))).toEqual({
      locale: "en",
      canGrantPlatformAdmin: true,
      canCreateActive: true,
    });
  });

  it("does not offer it to an org-bound superuser context (MACHINE-2)", async () => {
    checkAdminPermissionServer.mockResolvedValue({
      betterAuthUserId: "ba-1",
      access: { ...SUPERADMIN, orgBound: true },
    });
    expect(formProps(await Page(params))).toMatchObject({ canGrantPlatformAdmin: false });
  });

  // F-480: an org admin's user joins the org, so Active is an approval; the
  // page offers it with the API's predicate (`mayCreateUser`, real here).
  it("offers Active to an org admin who may enrol and approve (update + manage)", async () => {
    checkAdminPermissionServer.mockResolvedValue({
      betterAuthUserId: "ba-1",
      access: { ...ORG_ADMIN, permissions: [...ORG_ADMIN.permissions, "admin.users.manage"] },
    });
    expect(formProps(await Page(params))).toMatchObject({ canCreateActive: true });
  });

  it("offers the form (Pending only) with admin.orgs.update as the membership permission", async () => {
    checkAdminPermissionServer.mockResolvedValue({
      betterAuthUserId: "ba-1",
      access: { ...ORG_ADMIN, permissions: ["admin.users.create", "admin.orgs.update"] },
    });
    expect(formProps(await Page(params))).toMatchObject({ canCreateActive: false });
  });

  // F-480: the API refuses EVERY create from a confined caller with no
  // membership permission, Pending and Active alike, so the form is not
  // offered at all; the notice says what is missing. Approval alone does not
  // stand in for it.
  it.each([
    ["create only", ["admin.users.read", "admin.users.create"]],
    ["create and approve, no membership permission", ["admin.users.create", "admin.users.manage"]],
  ])(
    "shows a notice instead of the form to an org admin holding %s",
    async (_label, permissions) => {
      checkAdminPermissionServer.mockResolvedValue({
        betterAuthUserId: "ba-1",
        access: { ...ORG_ADMIN, permissions },
      });
      const tree = await Page(params);
      expect(formProps(tree)).toBeNull();
      expect(texts(tree)).toContain("new.enrolmentNotPermitted");
      // The page itself still answers: its guard key is the nav link's.
      expect(checkAdminPermissionServer).toHaveBeenCalledWith("admin.users.create");
      expect(notFoundMock).not.toHaveBeenCalled();
    },
  );

  it("offers the whole form to a superadmin with no membership permission (it enrols nobody)", async () => {
    checkAdminPermissionServer.mockResolvedValue({
      betterAuthUserId: "ba-1",
      access: { ...ORG_ADMIN, permissions: ["admin.users.create", "superuser"] },
    });
    const tree = await Page(params);
    expect(formProps(tree)).toMatchObject({ canCreateActive: true });
    expect(texts(tree)).not.toContain("new.enrolmentNotPermitted");
  });

  it("does not offer Active to an org-bound context without the approval permission", async () => {
    checkAdminPermissionServer.mockResolvedValue({
      betterAuthUserId: "ba-1",
      access: { ...ORG_ADMIN, orgBound: true },
    });
    expect(formProps(await Page(params))).toMatchObject({ canCreateActive: false });
  });

  it("still 404s when the permission guard denies", async () => {
    checkAdminPermissionServer.mockResolvedValue("denied");
    await expect(Page(params)).rejects.toThrow(NOT_FOUND);
  });
});
