import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EditPageModule from "@/app/[locale]/(secure)/app/administrator/email/templates/[templateId]/page";
import type * as ListPageModule from "@/app/[locale]/(secure)/app/administrator/email/templates/page";
import { systemFormatPreferences, type FormatPreferences } from "@/lib/format/app-format";

/**
 * Review #73 — the email-template EDIT page gated on `admin.email.manage`
 * while the `PUT /api/administrator/email/templates/[id]` it drives is
 * SUPERADMIN-only (the catalog is platform-global config shared by every
 * tenant). A permitted org admin therefore reached a fully rendered form whose
 * every save answered 403 — a dead end, reachable from an Edit link gated on
 * the same too-weak permission.
 *
 * The page guard must equal the mutation's authority, and the link that leads
 * there must equal the page guard.
 */
const NOT_FOUND = "__NOT_FOUND_SENTINEL__";
const notFoundMock = vi.fn(() => {
  throw new Error(NOT_FOUND);
});
const checkAdminPermissionServer = vi.fn();
const isSuperadmin = vi.fn();
const executeTakeFirst = vi.fn();
const listExecute = vi.fn();

vi.mock("next/navigation", () => ({
  notFound: () => notFoundMock(),
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
vi.mock("@/lib/admin/access-scope.server", () => ({
  isSuperadmin: (...a: unknown[]) => isSuperadmin(...a),
}));
vi.mock("@/db/database", () => {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return () => executeTakeFirst();
        if (prop === "execute") return () => listExecute();
        return () => chain;
      },
    },
  );
  return { db: { selectFrom: () => chain } };
});
vi.mock(
  "@/app/[locale]/(secure)/app/administrator/email/templates/[templateId]/_template-edit-form",
  () => ({
    TemplateEditForm: () => null,
  }),
);
vi.mock("@/app/[locale]/(secure)/app/administrator/email/templates/_template-filters", () => ({
  EmailTemplateFilters: () => null,
}));
// The list page formats "Updated" with the viewer's formatter (F-37). The real
// one reads the request's session cookie; there is no request here.
let viewerPrefs: FormatPreferences;
vi.mock("@/lib/format/viewer-format.server", async () => {
  const { createAppFormatter } = await import("@/lib/format/app-format");
  return {
    getAppFormatter: async (locale: string) => createAppFormatter(locale, viewerPrefs),
  };
});

const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS = {
  appUserId: "admin-app-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.email.read", "admin.email.manage"],
};
const TEMPLATE_ROW = {
  id: TEMPLATE_ID,
  key: "welcome",
  locale: "en",
  subject: "Hi",
  body_html: "<p>Hi</p>",
  body_text: "Hi",
  description: null,
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

let EditPage: typeof EditPageModule.default;
let ListPage: typeof ListPageModule.default;

beforeEach(async () => {
  for (const m of [checkAdminPermissionServer, isSuperadmin, executeTakeFirst, listExecute])
    m.mockReset();
  notFoundMock.mockClear();
  viewerPrefs = systemFormatPreferences("UTC");
  checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-admin", access: ACCESS });
  executeTakeFirst.mockResolvedValue(TEMPLATE_ROW);
  listExecute.mockResolvedValue([TEMPLATE_ROW]);
  ({ default: EditPage } =
    await import("@/app/[locale]/(secure)/app/administrator/email/templates/[templateId]/page"));
  ({ default: ListPage } =
    await import("@/app/[locale]/(secure)/app/administrator/email/templates/page"));
});
afterEach(() => vi.resetModules());

const editParams = { params: Promise.resolve({ locale: "en", templateId: TEMPLATE_ID }) };
const listParams = {
  params: Promise.resolve({ locale: "en" }),
  searchParams: Promise.resolve({}),
};

describe("email template edit page — guard equals the mutation (review #73)", () => {
  it("404s an admin.email.manage holder who is NOT a SUPERADMIN, before reading the row", async () => {
    isSuperadmin.mockReturnValue(false);
    await expect(EditPage(editParams)).rejects.toThrow(NOT_FOUND);
    expect(executeTakeFirst).not.toHaveBeenCalled();
  });

  it("renders for a SUPERADMIN", async () => {
    isSuperadmin.mockReturnValue(true);
    expect(await EditPage(editParams)).toBeTruthy();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("still 404s when the permission guard itself denies", async () => {
    isSuperadmin.mockReturnValue(true);
    checkAdminPermissionServer.mockResolvedValue("denied");
    await expect(EditPage(editParams)).rejects.toThrow(NOT_FOUND);
    expect(checkAdminPermissionServer).toHaveBeenCalledWith("admin.email.manage");
  });
});

describe("email template list — the Edit link matches the page guard (review #73)", () => {
  /** Does the rendered tree contain a link into the edit page? */
  function hasEditLink(node: unknown): boolean {
    if (!node || typeof node !== "object") return false;
    const el = node as { props?: Record<string, unknown> };
    const href = el.props?.href;
    if (typeof href === "string" && href.includes("/email/templates/")) return true;
    for (const key of ["children"] as const) {
      const value = el.props?.[key];
      for (const child of Array.isArray(value) ? value.flat(Infinity) : [value]) {
        if (hasEditLink(child)) return true;
      }
    }
    return false;
  }

  it("hides the Edit link from a non-SUPERADMIN admin.email.manage holder", async () => {
    isSuperadmin.mockReturnValue(false);
    expect(hasEditLink(await ListPage(listParams))).toBe(false);
  });

  it("shows the Edit link to a SUPERADMIN", async () => {
    isSuperadmin.mockReturnValue(true);
    expect(hasEditLink(await ListPage(listParams))).toBe(true);
  });
});

/**
 * F-37: "Updated" was `updated_at.toISOString().slice(0, 16)`, a UTC time
 * with no zone marker that read as local. It must follow the viewer's saved
 * zone and date format like every other timestamp in the app.
 */
describe("email template list — Updated follows the viewer's formats (F-37)", () => {
  /** All the text in the rendered tree, each text node followed by a `|`. */
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return `${node}|`;
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (!node || typeof node !== "object") return "";
    return textOf((node as { props?: { children?: unknown } }).props?.children);
  }

  it("shows the saved zone and date format", async () => {
    isSuperadmin.mockReturnValue(false);
    // 00:00 UTC on Jan 1 is 05:45 in Kathmandu (UTC+5:45).
    viewerPrefs = { timeZone: "Asia/Kathmandu", dateFormat: "iso8601", numberLocale: null };
    const text = textOf(await ListPage(listParams));
    expect(text).toContain("|2026-01-01 05:45|");
    expect(text).not.toContain("2026-01-01T00:00");
  });

  it("shows the locale's own style in the deployment zone when nothing is saved", async () => {
    isSuperadmin.mockReturnValue(false);
    const text = textOf(await ListPage(listParams));
    const expected = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(TEMPLATE_ROW.updated_at);
    expect(text).toContain(`|${expected}|`);
  });
});
