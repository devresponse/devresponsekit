import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NewPageModule from "@/app/[locale]/(secure)/app/administrator/enterprise-apps/new/page";
import type * as DetailPageModule from "@/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/page";

/**
 * Executes the enterprise-app New and detail RSCs (R14).
 *
 * The New form sent no `organization_id`, so every create from the console was
 * a global app, which `POST /api/administrator/enterprise-apps` refuses to a
 * caller without cross-org reach: an org admin could not create any app. The
 * page now resolves the caller's scope with the route's own rule
 * (`resolveOrgScope`, real here) and hands the form plain data: the picker for
 * a caller with cross-org reach, its own org (id and slug, for the I-01 name
 * prefix) for a confined one. The detail page hands the settings form the
 * app's slug for a confined caller, whose audience the route holds to it. The
 * component suites pin what the forms do with these props.
 */
const NOT_FOUND = "__NOT_FOUND_SENTINEL__";
const checkAdminPermissionServer = vi.fn();
const selectFirst = vi.fn();
const whereArgs: unknown[][] = [];

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/admin/permissions.server", () => ({
  checkAdminPermissionServer: (...a: unknown[]) => checkAdminPermissionServer(...a),
}));
vi.mock("@/db/database", () => {
  const chain: Record<string, unknown> = {};
  for (const method of ["selectFrom", "leftJoin", "select"]) chain[method] = () => chain;
  chain.where = (...args: unknown[]) => {
    whereArgs.push(args);
    return chain;
  };
  chain.executeTakeFirst = () => selectFirst();
  return { db: chain };
});
// The client islands: the pages only forward props to them.
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/enterprise-apps/new/_new-enterprise-app-form",
  () => ({
    NewEnterpriseAppForm: function NewEnterpriseAppForm() {
      return null;
    },
  }),
);
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/_enterprise-app-settings-form",
  () => ({
    EnterpriseAppSettingsForm: function EnterpriseAppSettingsForm() {
      return null;
    },
  }),
);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ADMIN = {
  appUserId: "admin-app-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: ORG_ID,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.apps.read", "admin.apps.manage"],
  orgBound: false,
};
const SUPERADMIN = { ...ORG_ADMIN, permissions: [...ORG_ADMIN.permissions, "superuser"] };

let NewPage: typeof NewPageModule.default;
let DetailPage: typeof DetailPageModule.default;

beforeEach(async () => {
  checkAdminPermissionServer.mockReset();
  selectFirst.mockReset();
  whereArgs.length = 0;
  ({ default: NewPage } =
    await import("@/app/[locale]/(secure)/app/administrator/enterprise-apps/new/page"));
  ({ default: DetailPage } =
    await import("@/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/page"));
});
afterEach(() => vi.resetModules());

/** The props the page hands to the client component `name`, found in the rendered tree. */
function propsOf(node: unknown, name: string): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: { name?: string }; props?: Record<string, unknown> };
  if (el.type?.name === name) return el.props ?? null;
  const children = el.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = propsOf(child, name);
    if (found) return found;
  }
  return null;
}

const asCaller = (access: object) =>
  checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-1", access });

describe("new enterprise-app page — the form sends the route's scope (R14)", () => {
  const newParams = { params: Promise.resolve({ locale: "en" }) };

  it("hands an org admin its own org (id and slug) and no picker", async () => {
    asCaller(ORG_ADMIN);
    selectFirst.mockResolvedValueOnce({ id: ORG_ID, slug: "acme" });
    expect(propsOf(await NewPage(newParams), "NewEnterpriseAppForm")).toEqual({
      locale: "en",
      showOrgPicker: false,
      ownOrganization: { id: ORG_ID, slug: "acme" },
    });
    expect(checkAdminPermissionServer).toHaveBeenCalledWith("admin.apps.manage");
    expect(whereArgs).toEqual([["id", "=", ORG_ID]]);
  });

  it("hands a superadmin the picker and no org", async () => {
    asCaller(SUPERADMIN);
    expect(propsOf(await NewPage(newParams), "NewEnterpriseAppForm")).toEqual({
      locale: "en",
      showOrgPicker: true,
      ownOrganization: null,
    });
    expect(selectFirst).not.toHaveBeenCalled();
  });

  it("confines an org-bound superuser context like an org admin (MACHINE-2)", async () => {
    asCaller({ ...SUPERADMIN, orgBound: true });
    selectFirst.mockResolvedValueOnce({ id: ORG_ID, slug: "acme" });
    expect(propsOf(await NewPage(newParams), "NewEnterpriseAppForm")).toMatchObject({
      showOrgPicker: false,
      ownOrganization: { id: ORG_ID, slug: "acme" },
    });
  });

  it("offers a confined caller with no active org neither a picker nor an org", async () => {
    asCaller({ ...ORG_ADMIN, organizationId: null });
    expect(propsOf(await NewPage(newParams), "NewEnterpriseAppForm")).toMatchObject({
      showOrgPicker: false,
      ownOrganization: null,
    });
    expect(selectFirst).not.toHaveBeenCalled();
  });

  it("is Not Found without admin.apps.manage", async () => {
    checkAdminPermissionServer.mockResolvedValue("denied");
    await expect(NewPage(newParams)).rejects.toThrow(NOT_FOUND);
  });
});

describe("enterprise-app detail page — the audience namespace (R14)", () => {
  const detailParams = { params: Promise.resolve({ locale: "en", appId: "acme.crm" }) };
  const ROW = {
    id: "acme.crm",
    label: "CRM",
    description: null,
    origin: "https://crm.example.com",
    subdomain: "crm",
    sso_audience: "devresponse-app:acme.crm",
    status: "available",
    sort_order: 100,
    organization_id: ORG_ID,
    organization_slug: "acme",
  };

  it("hands an org admin's settings form its org's slug", async () => {
    asCaller(ORG_ADMIN);
    selectFirst.mockResolvedValueOnce(ROW);
    expect(propsOf(await DetailPage(detailParams), "EnterpriseAppSettingsForm")).toMatchObject({
      canManage: true,
      namespaceSlug: "acme",
    });
  });

  it("hands a superadmin's settings form no slug", async () => {
    asCaller(SUPERADMIN);
    selectFirst.mockResolvedValueOnce(ROW);
    expect(propsOf(await DetailPage(detailParams), "EnterpriseAppSettingsForm")).toMatchObject({
      namespaceSlug: null,
    });
  });
});
