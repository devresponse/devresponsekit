import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PageModule from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/page";
import type * as OrgsModule from "@/lib/admin/orgs.server";

/**
 * Review #72 — the organization-detail RSC streamed the PLATFORM-DEFAULT auth
 * policy into the Authentication tab for every `admin.orgs.read` holder, while
 * the API that serves that row (`GET /api/administrator/auth-settings/
 * defaults`) answers 403 to anyone who is not a SUPERADMIN. The page therefore
 * out-authorized the API it mirrors.
 *
 * The one case an org admin may legitimately see those values is when their
 * org INHERITS them: the org's own `auth-settings` GET already returns exactly
 * that policy as `effective` with `source: "platform_default"`. So the rule is
 * SUPERADMIN, or no override on this org — and nothing else.
 */
const NOT_FOUND = "__NOT_FOUND_SENTINEL__";
const notFoundMock = vi.fn(() => {
  throw new Error(NOT_FOUND);
});
const checkAdminPermissionServer = vi.fn();
const canAccessOrg = vi.fn();
const isSuperadmin = vi.fn();
const getOrgAuthSettingsRow = vi.fn();
const loadOrgOrThrow = vi.fn();

vi.mock("next/navigation", () => ({ notFound: () => notFoundMock() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/admin/permissions.server", () => ({
  checkAdminPermissionServer: (...a: unknown[]) => checkAdminPermissionServer(...a),
}));
vi.mock("@/lib/admin/access-scope.server", () => ({
  canAccessOrg: (...a: unknown[]) => canAccessOrg(...a),
  isSuperadmin: (...a: unknown[]) => isSuperadmin(...a),
}));
vi.mock("@/lib/admin/auth-settings.server", () => ({
  getOrgAuthSettingsRow: (...a: unknown[]) => getOrgAuthSettingsRow(...a),
}));
vi.mock("@/lib/admin/orgs.server", async () => {
  const actual = await vi.importActual<typeof OrgsModule>("@/lib/admin/orgs.server");
  return { ...actual, loadOrgOrThrow: (...a: unknown[]) => loadOrgOrThrow(...a) };
});
// Client island: the page only forwards props; it is not under test.
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-detail-tabs",
  () => ({ OrganizationDetailTabs: () => null }),
);
vi.mock("@/components/ui/status-badge", () => ({ StatusBadge: () => null }));
vi.mock("@/components/ui/badge", () => ({ Badge: () => null }));

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCESS = {
  appUserId: "admin-app-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: ORG_ID,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.orgs.read"],
};
const ORG_ROW = {
  id: ORG_ID,
  slug: "acme",
  name: "Acme",
  status: "active",
  is_default: false,
  member_count: 3,
  binding_count: 0,
};
const POLICY = {
  requireEmailVerification: true,
  signupApprovalMode: "admin_approval",
  allowedAuthMethods: ["email_password"],
  autoApproveEmailDomains: [],
};
const ORG_OVERRIDE = { ...POLICY, signupApprovalMode: "auto_active" };

let Page: typeof PageModule.default;

function params(orgId: string) {
  return { params: Promise.resolve({ locale: "en", orgId }) };
}

/** Depth-first search for the props handed to OrganizationDetailTabs. */
function findTabsProps(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  const el = node as { props?: Record<string, unknown> };
  if (el.props && "platformAuthDefaults" in el.props) return el.props;
  const children = el.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findTabsProps(child);
    if (found) return found;
  }
  return undefined;
}

beforeEach(async () => {
  for (const m of [
    checkAdminPermissionServer,
    canAccessOrg,
    isSuperadmin,
    getOrgAuthSettingsRow,
    loadOrgOrThrow,
  ])
    m.mockReset();
  notFoundMock.mockClear();
  checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-admin", access: ACCESS });
  canAccessOrg.mockReturnValue(true);
  isSuperadmin.mockReturnValue(false);
  loadOrgOrThrow.mockResolvedValue(ORG_ROW);
  // organizationId === null is the platform-default row.
  getOrgAuthSettingsRow.mockImplementation(async (id: string | null) =>
    id === null ? POLICY : ORG_OVERRIDE,
  );
  ({ default: Page } =
    await import("@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/page"));
});
afterEach(() => vi.resetModules());

describe("administrator/organizations/[orgId] — platform defaults (review #72)", () => {
  it("withholds the platform default from an org admin whose org has its OWN override", async () => {
    const props = findTabsProps(await Page(params(ORG_ID)))!;
    expect(props.authSettings).toMatchObject({ signupApprovalMode: "auto_active" });
    expect(props.platformAuthDefaults).toBeNull();
    // The SUPERADMIN-only row is never even read.
    expect(getOrgAuthSettingsRow).toHaveBeenCalledTimes(1);
    expect(getOrgAuthSettingsRow).toHaveBeenCalledWith(ORG_ID);
  });

  it("gives the platform default to an org admin whose org INHERITS it (already visible via the org's own API)", async () => {
    getOrgAuthSettingsRow.mockImplementation(async (id: string | null) =>
      id === null ? POLICY : null,
    );
    const props = findTabsProps(await Page(params(ORG_ID)))!;
    expect(props.authSettings).toBeNull();
    expect(props.platformAuthDefaults).toMatchObject({ signupApprovalMode: "admin_approval" });
  });

  it("gives the platform default to a SUPERADMIN even when the org overrides", async () => {
    isSuperadmin.mockReturnValue(true);
    const props = findTabsProps(await Page(params(ORG_ID)))!;
    expect(props.authSettings).toMatchObject({ signupApprovalMode: "auto_active" });
    expect(props.platformAuthDefaults).toMatchObject({ signupApprovalMode: "admin_approval" });
  });

  it("still enforces the tenant gate before reading any policy at all (ADR-0001)", async () => {
    canAccessOrg.mockReturnValue(false);
    await expect(Page(params(ORG_ID))).rejects.toThrow(NOT_FOUND);
    expect(getOrgAuthSettingsRow).not.toHaveBeenCalled();
  });
});
