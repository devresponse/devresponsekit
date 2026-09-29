import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANY_ADMIN_PERMISSION, SUPERUSER_PERMISSIONS } from "@/lib/admin/permissions";
import type * as RolesModule from "@/lib/admin/roles.server";
import OrganizationsPage from "@/app/[locale]/(secure)/app/administrator/organizations/page";
import NewOrganizationPage from "@/app/[locale]/(secure)/app/administrator/organizations/new/page";
import PermissionsPage from "@/app/[locale]/(secure)/app/administrator/permissions/page";
import NewPermissionPage from "@/app/[locale]/(secure)/app/administrator/permissions/new/page";
import GroupDetailPage from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/page";
import ApiKeysPage from "@/app/[locale]/(secure)/app/administrator/api-keys/page";
import MembershipsPage from "@/app/[locale]/(secure)/app/administrator/memberships/page";
import RolesPage from "@/app/[locale]/(secure)/app/administrator/roles/page";
import RoleDetailPage from "@/app/[locale]/(secure)/app/administrator/roles/[roleId]/page";

/**
 * The administrator RSC pages hand their client islands only the actions and
 * links whose API or page guards the viewer passes.
 *
 * F-66: creating or deleting an organization, editing its settings and every
 * write to the permission catalog are platform-wide, so the routes refuse any
 * caller without cross-org reach (403) AFTER the key check passes. The pages
 * derived their flags from the keys alone, so every org admin on the seeded
 * `admin.platform` role (which holds every `admin.*` key) was offered a New
 * button, a Delete action, and New/Edit/Delete on the catalog that always
 * failed, plus two "new" pages whose every submit 403'd.
 *
 * F-67: a page's grids and pickers read other areas' APIs and link to other
 * areas' pages, whose permissions the page never checked. Each page now passes
 * the destination's read permission down as a boolean.
 *
 * The access-scope predicates are the real ones; only the session lookup and
 * the data loaders are stubbed.
 */
const NOT_FOUND = "__NOT_FOUND_SENTINEL__";
const notFoundMock = vi.fn(() => {
  throw new Error(NOT_FOUND);
});
const checkAdminPermissionServer = vi.fn();
const loadGroupDetail = vi.fn();
const loadRoleOrThrow = vi.fn();

vi.mock("next/navigation", () => ({
  notFound: () => notFoundMock(),
  // The pages' LocaleLink buttons pull in next-intl's navigation helpers.
  redirect: () => undefined,
  permanentRedirect: () => undefined,
  useRouter: () => ({ push: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/admin/permissions.server", () => ({
  checkAdminPermissionServer: (...a: unknown[]) => checkAdminPermissionServer(...a),
}));
vi.mock("@/lib/admin/auth-settings.server", () => ({ getOrgAuthSettingsRow: async () => null }));
vi.mock("@/lib/admin/groups.server", () => ({
  loadGroupDetail: (...a: unknown[]) => loadGroupDetail(...a),
}));
vi.mock("@/lib/admin/roles.server", async () => {
  const actual = await vi.importActual<typeof RolesModule>("@/lib/admin/roles.server");
  return { ...actual, loadRoleOrThrow: (...a: unknown[]) => loadRoleOrThrow(...a) };
});
// Client islands: the pages only forward props; they are not under test.
vi.mock("@/app/[locale]/(secure)/app/administrator/organizations/_organizations-grid", () => ({
  AdministratorOrganizationsGrid: () => null,
}));
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/new/_new-organization-form",
  () => ({ NewOrganizationForm: () => null }),
);
vi.mock("@/app/[locale]/(secure)/app/administrator/permissions/_permissions-grid", () => ({
  AdministratorPermissionsGrid: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/permissions/new/_new-permission-form", () => ({
  NewPermissionForm: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-detail-tabs", () => ({
  GroupDetailTabs: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/api-keys/_api-keys-grid", () => ({
  AdministratorApiKeysGrid: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/memberships/_memberships-grid", () => ({
  AdministratorMembershipsGrid: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/roles/_roles-grid", () => ({
  AdministratorRolesGrid: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/roles/[roleId]/_role-detail-tabs", () => ({
  RoleDetailTabs: () => null,
}));
vi.mock("@/components/admin/auth-policy-form", () => ({ AuthPolicyForm: () => null }));

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE_ACCESS = {
  appUserId: "admin-app-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: ORG_ID,
  membershipStatus: "active",
  preferredLocale: "en",
};
/** The seeded `admin.platform` role: every `admin.*` key, no `superuser` marker. */
const ORG_ADMIN = [...ANY_ADMIN_PERMISSION];
const SUPERADMIN = [...SUPERUSER_PERMISSIONS];

function signedInWith(permissions: string[]) {
  checkAdminPermissionServer.mockResolvedValue({
    betterAuthUserId: "ba-admin",
    access: { ...BASE_ACCESS, permissions },
  });
}

const params = <T extends Record<string, string>>(extra?: T) => ({
  params: Promise.resolve({ locale: "en", ...extra } as { locale: string } & T),
});

/** Depth-first search for the first element props that carry `key`. */
function propsWith(node: unknown, key: string): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  const el = node as { props?: Record<string, unknown> };
  if (el.props && key in el.props) return el.props;
  const children = el.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = propsWith(child, key);
    if (found) return found;
  }
  return undefined;
}

beforeEach(() => {
  checkAdminPermissionServer.mockReset();
  loadGroupDetail.mockReset();
  loadRoleOrThrow.mockReset();
  notFoundMock.mockClear();
});

describe("organizations list (F-66)", () => {
  it("offers an org admin holding every key neither New nor Delete", async () => {
    signedInWith(ORG_ADMIN);
    const grid = propsWith(await OrganizationsPage(params()), "canDelete")!;
    expect(grid.canDelete).toBe(false);
    expect(grid.headerActions).toBeNull();
  });

  it("offers both to a superadmin", async () => {
    signedInWith(SUPERADMIN);
    const grid = propsWith(await OrganizationsPage(params()), "canDelete")!;
    expect(grid.canDelete).toBe(true);
    expect(grid.headerActions).not.toBeNull();
  });
});

describe("organizations/new (F-66)", () => {
  it("is notFound() for an org admin holding admin.orgs.create", async () => {
    signedInWith(ORG_ADMIN);
    await expect(NewOrganizationPage(params())).rejects.toThrow(NOT_FOUND);
  });

  it("renders for a superadmin", async () => {
    signedInWith(SUPERADMIN);
    await expect(NewOrganizationPage(params())).resolves.toBeTruthy();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});

describe("permission catalog (F-66)", () => {
  it("offers an org admin holding admin.permissions.manage no catalog writes", async () => {
    signedInWith(ORG_ADMIN);
    const grid = propsWith(await PermissionsPage(params()), "canManage")!;
    expect(grid.canManage).toBe(false);
    expect(grid.headerActions).toBeUndefined();
  });

  it("offers them to a superadmin", async () => {
    signedInWith(SUPERADMIN);
    const grid = propsWith(await PermissionsPage(params()), "canManage")!;
    expect(grid.canManage).toBe(true);
    expect(grid.headerActions).toBeDefined();
  });

  it("permissions/new is notFound() for an org admin holding the key, and renders for a superadmin", async () => {
    signedInWith(ORG_ADMIN);
    await expect(NewPermissionPage(params())).rejects.toThrow(NOT_FOUND);
    signedInWith(SUPERADMIN);
    await expect(NewPermissionPage(params())).resolves.toBeTruthy();
  });
});

describe("group detail (F-67)", () => {
  const GROUP = {
    id: ENTITY_ID,
    organization_id: ORG_ID,
    key: "support",
    name: "Support",
    description: null,
    memberCount: 2,
  };

  it("tells the tabs whether the viewer may read roles and users", async () => {
    loadGroupDetail.mockResolvedValue(GROUP);
    signedInWith(["admin.groups.read", "admin.groups.assign"]);
    const manager = propsWith(await GroupDetailPage(params({ groupId: ENTITY_ID })), "canAssign")!;
    expect(manager).toMatchObject({ canAssign: true, canReadRoles: false, canReadUsers: false });

    signedInWith(["admin.groups.read", "admin.roles.read", "admin.users.read"]);
    const reader = propsWith(await GroupDetailPage(params({ groupId: ENTITY_ID })), "canAssign")!;
    expect(reader).toMatchObject({ canAssign: false, canReadRoles: true, canReadUsers: true });
  });
});

describe("cross-links on the list and detail pages (F-67)", () => {
  it("API keys link their owners only for admin.users.read", async () => {
    signedInWith(["admin.apikeys.read"]);
    expect(propsWith(await ApiKeysPage(params()), "canReadUsers")!.canReadUsers).toBe(false);
    signedInWith(["admin.apikeys.read", "admin.users.read"]);
    expect(propsWith(await ApiKeysPage(params()), "canReadUsers")!.canReadUsers).toBe(true);
  });

  it("memberships link their users only for admin.users.read", async () => {
    signedInWith(["admin.orgs.read"]);
    expect(propsWith(await MembershipsPage(params()), "canReadUsers")!.canReadUsers).toBe(false);
    signedInWith(["admin.orgs.read", "admin.users.read"]);
    expect(propsWith(await MembershipsPage(params()), "canReadUsers")!.canReadUsers).toBe(true);
  });

  it("roles link their organization only for admin.orgs.read", async () => {
    signedInWith(["admin.roles.read"]);
    expect(propsWith(await RolesPage(params()), "canReadOrgs")!.canReadOrgs).toBe(false);
    signedInWith(["admin.roles.read", "admin.orgs.read"]);
    expect(propsWith(await RolesPage(params()), "canReadOrgs")!.canReadOrgs).toBe(true);
  });

  it("a role's members link to the user page only for admin.users.read", async () => {
    loadRoleOrThrow.mockResolvedValue({
      id: ENTITY_ID,
      organization_id: ORG_ID,
      key: "support",
      name: "Support",
      description: null,
      permissionKeys: [],
      memberCount: 0,
    });
    const page = () => RoleDetailPage(params({ roleId: ENTITY_ID }));
    signedInWith(["admin.roles.read"]);
    expect(propsWith(await page(), "canReadUsers")!.canReadUsers).toBe(false);
    signedInWith(["admin.roles.read", "admin.users.read"]);
    expect(propsWith(await page(), "canReadUsers")!.canReadUsers).toBe(true);
  });
});
