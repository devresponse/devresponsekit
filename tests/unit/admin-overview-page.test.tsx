import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type * as OverviewPageModule from "@/app/[locale]/(secure)/app/administrator/page";
import type { FormatPreferences } from "@/lib/format/app-format";

/**
 * The Administrator overview is a server component that formats its own
 * headline counts, activity times and chart day labels (F-37). No other suite
 * renders it, so without this file the page could drop the viewer's formatter
 * (`String(n)`, a zone-less `toISOString()`) or stop handing the viewer's zone
 * to the daily charts, and every check would stay green.
 *
 * Everything the page reads is mocked. The child components are stubs, so the
 * page's returned tree is inspected as data: each stub element carries exactly
 * the props the page computed.
 */
const checkAdminPermissionServer = vi.fn();
const getAdministratorOverviewMetrics = vi.fn();
const getAdministratorOverviewActivity = vi.fn();
const selectDashboardMetrics = vi.fn();
let viewerPrefs: FormatPreferences;

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/admin/permissions.server", () => ({
  ANY_ADMIN_PERMISSION: ["admin.users.read"],
  checkAdminPermissionServer: (...a: unknown[]) => checkAdminPermissionServer(...a),
}));
vi.mock("@/lib/admin/access-scope.server", () => ({
  resolveOrgScope: () => ({ kind: "all" }),
}));
vi.mock("@/lib/admin/overview.server", () => ({
  getAdministratorOverviewMetrics: (...a: unknown[]) => getAdministratorOverviewMetrics(...a),
  getAdministratorOverviewActivity: (...a: unknown[]) => getAdministratorOverviewActivity(...a),
}));
vi.mock("@/lib/admin/dashboard-metrics.server", () => ({
  selectDashboardMetrics: (...a: unknown[]) => selectDashboardMetrics(...a),
}));
// The real lookup reads the request's session cookie; there is no request here.
vi.mock("@/lib/format/viewer-format.server", async () => {
  const { createAppFormatter } = await import("@/lib/format/app-format");
  return {
    getViewerFormatPreferences: async () => viewerPrefs,
    getAppFormatter: async (locale: string) => createAppFormatter(locale, viewerPrefs),
  };
});
vi.mock("@/app/[locale]/(secure)/app/administrator/_components/metric-card", () => ({
  MetricCard: function MetricCard() {
    return null;
  },
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/_components/overview-list-card", () => ({
  OverviewListCard: function OverviewListCard() {
    return null;
  },
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/_components/metric-bar-chart", () => ({
  MetricBarChart: function MetricBarChart() {
    return null;
  },
}));

const ACCESS = {
  appUserId: "admin-app-1",
  organizationId: null,
  permissions: [
    "superuser",
    "admin.users.read",
    "admin.orgs.read",
    "admin.roles.read",
    "admin.apps.read",
    "admin.audit.read",
  ],
};

// 20:30 UTC on the 13th is 02:15 on the 14th in Kathmandu (UTC+5:45).
const REGISTERED_AT = "2026-06-13T20:30:00.000Z";

let AdministratorPage: typeof OverviewPageModule.default;

beforeEach(async () => {
  for (const m of [
    checkAdminPermissionServer,
    getAdministratorOverviewMetrics,
    getAdministratorOverviewActivity,
    selectDashboardMetrics,
  ])
    m.mockReset();
  viewerPrefs = { timeZone: "Asia/Kathmandu", dateFormat: "iso8601", numberLocale: "fr" };
  checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-1", access: ACCESS });
  getAdministratorOverviewMetrics.mockResolvedValue({
    users: { total: 12345, active: 12000, pendingApproval: 345 },
    organizations: { total: 7 },
  });
  getAdministratorOverviewActivity.mockResolvedValue({
    registrations: [
      {
        id: "u-1",
        email: "a@x.test",
        displayName: "Ada",
        status: "active",
        createdAt: REGISTERED_AT,
      },
    ],
  });
  selectDashboardMetrics.mockResolvedValue({
    scope: "system",
    organizationId: null,
    windowDays: 7,
    registrationsDaily: [
      { date: "2026-06-13", count: 0 },
      { date: "2026-06-14", count: 1 },
    ],
  });
  ({ default: AdministratorPage } = await import("@/app/[locale]/(secure)/app/administrator/page"));
});
afterEach(() => vi.resetModules());

type AnyElement = ReactElement<Record<string, unknown>>;

/** Every element in the tree whose (stub) component has this name. */
function findAll(node: unknown, name: string, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, name, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as AnyElement;
  if (typeof el.type === "function" && el.type.name === name) out.push(el);
  findAll(el.props.children, name, out);
  return out;
}

async function renderPage() {
  return AdministratorPage({ params: Promise.resolve({ locale: "en" }) });
}

describe("Administrator overview — the viewer's formats (F-37)", () => {
  it("counts the daily charts' days in the viewer's zone", async () => {
    await renderPage();
    expect(selectDashboardMetrics).toHaveBeenCalledWith(ACCESS, { timeZone: "Asia/Kathmandu" });
  });

  it("groups the headline counts in the saved number-format locale", async () => {
    const cards = findAll(await renderPage(), "MetricCard");
    const users = cards.find((c) => c.props.label === "metrics.users");
    expect(users?.props.value).toBe(new Intl.NumberFormat("fr").format(12345));
    expect(users?.props.value).not.toBe("12,345");
    expect(cards.find((c) => c.props.label === "metrics.organizations")?.props.value).toBe("7");
  });

  it("shows activity times in the saved zone and date format", async () => {
    const [registrations] = findAll(await renderPage(), "OverviewListCard");
    const rows = registrations?.props.rows as { cells: AnyElement[] }[];
    const created = rows[0]!.cells[2]!;
    expect(created.props.children).toBe("2026-06-14 02:15");
  });

  it("labels each chart day with the day it counted, in the saved date format", async () => {
    const [chart] = findAll(await renderPage(), "MetricBarChart");
    expect(chart?.props.data).toEqual([
      { label: "06-13", value: 0 },
      { label: "06-14", value: 1 },
    ]);
  });

  it("follows the locale's own style when nothing is saved", async () => {
    viewerPrefs = { timeZone: "UTC", dateFormat: "system", numberLocale: null };
    const tree = await renderPage();

    expect(selectDashboardMetrics).toHaveBeenCalledWith(ACCESS, { timeZone: "UTC" });
    const users = findAll(tree, "MetricCard").find((c) => c.props.label === "metrics.users");
    expect(users?.props.value).toBe("12,345");
    const [registrations] = findAll(tree, "OverviewListCard");
    const rows = registrations?.props.rows as { cells: AnyElement[] }[];
    expect(rows[0]!.cells[2]!.props.children).toBe(
      new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(REGISTERED_AT)),
    );
    const [chart] = findAll(tree, "MetricBarChart");
    expect((chart?.props.data as { label: string }[]).map((d) => d.label)).toEqual([
      "Jun 13",
      "Jun 14",
    ]);
  });
});
