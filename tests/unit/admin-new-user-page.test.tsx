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
 * real one.
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

const ORG_ADMIN = {
  appUserId: "admin-app-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.users.read", "admin.users.create"],
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

describe("new-user page — the platform role is offered with the API's predicate (F-13)", () => {
  it("does not offer it to an org admin", async () => {
    checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-1", access: ORG_ADMIN });
    expect(formProps(await Page(params))).toEqual({ locale: "en", canGrantPlatformAdmin: false });
    expect(checkAdminPermissionServer).toHaveBeenCalledWith("admin.users.create");
  });

  it("offers it to a superadmin", async () => {
    checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-1", access: SUPERADMIN });
    expect(formProps(await Page(params))).toEqual({ locale: "en", canGrantPlatformAdmin: true });
  });

  it("does not offer it to an org-bound superuser context (MACHINE-2)", async () => {
    checkAdminPermissionServer.mockResolvedValue({
      betterAuthUserId: "ba-1",
      access: { ...SUPERADMIN, orgBound: true },
    });
    expect(formProps(await Page(params))).toMatchObject({ canGrantPlatformAdmin: false });
  });

  it("still 404s when the permission guard denies", async () => {
    checkAdminPermissionServer.mockResolvedValue("denied");
    await expect(Page(params)).rejects.toThrow(NOT_FOUND);
  });
});
