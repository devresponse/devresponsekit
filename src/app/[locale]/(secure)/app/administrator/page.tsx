import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getAdministratorOverviewActivity,
  getAdministratorOverviewMetrics,
  type OverviewActivity,
  type OverviewMetrics,
} from "@/lib/admin/overview.server";
import {
  selectDashboardMetrics,
  type DashboardMetrics,
} from "@/lib/admin/dashboard-metrics.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { ANY_ADMIN_PERMISSION, checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { MetricBarChart, type MetricBarDatum } from "./_components/metric-bar-chart";
import { MetricCard, type MetricCardProps } from "./_components/metric-card";
import { OverviewListCard, type OverviewListCardProps } from "./_components/overview-list-card";

export const dynamic = "force-dynamic";

/**
 * Administrator overview dashboard.
 *
 * Composition only: the query layer (`overview.server.ts`) counts, the
 * `MetricCard` displays, and this page maps permissions → metric
 * descriptors. Cards the caller cannot read are hidden entirely —
 * matching the sidebar's gating model — and their queries never run.
 *
 * Extending the dashboard = adding a descriptor below (and a slice in
 * the query layer when it needs new data).
 */

/** Maps each metric to its read permission, icon, and destination. */
const METRIC_DESCRIPTORS = [
  {
    id: "users",
    permission: "admin.users.read",
    icon: "users",
    href: "/app/administrator/users",
  },
  {
    id: "organizations",
    permission: "admin.orgs.read",
    icon: "building-2",
    href: "/app/administrator/organizations",
  },
  {
    id: "roles",
    permission: "admin.roles.read",
    icon: "shield",
    href: "/app/administrator/roles",
  },
  {
    id: "permissions",
    permission: "admin.roles.read",
    icon: "key-round",
    href: "/app/administrator/permissions",
  },
  {
    id: "enterpriseApps",
    permission: "admin.apps.read",
    icon: "app-window",
    href: "/app/administrator/enterprise-apps",
  },
] as const;

type MetricId = (typeof METRIC_DESCRIPTORS)[number]["id"];

export default async function AdministratorPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "administrator.overview" });

  // The layout already guarantees *some* admin permission; this re-read
  // is request-cached (React cache on the access context) and gives the
  // page the exact permission set for per-card gating.
  const guard = await checkAdminPermissionServer([...ANY_ADMIN_PERMISSION]);
  const access = typeof guard === "string" ? null : guard.access;
  const permissions = access?.permissions ?? [];

  const visible = METRIC_DESCRIPTORS.filter((d) => permissions.includes(d.permission));
  const visibleIds = new Set<MetricId>(visible.map((d) => d.id));

  // ADR-0001: every metric/activity query is bounded by the caller's org
  // boundary. SUPERADMIN → `{ kind: "all" }` (system-wide); org admin →
  // their own org only; `null` → no resolvable org, so the dashboard shows
  // nothing rather than leaking cross-tenant data.
  const scope = access ? resolveOrgScope(access) : null;

  const [metrics, activity, dashboardMetrics] = await Promise.all([
    scope
      ? getAdministratorOverviewMetrics(
          {
            users: visibleIds.has("users"),
            organizations: visibleIds.has("organizations"),
            roles: visibleIds.has("roles"),
            permissions: visibleIds.has("permissions"),
            enterpriseApps: visibleIds.has("enterpriseApps"),
          },
          scope,
        )
      : Promise.resolve({} as OverviewMetrics),
    scope
      ? getAdministratorOverviewActivity(
          {
            registrations: permissions.includes("admin.users.read"),
            // Session rows carry IPs — gate on the session-management
            // permission, not the broader users.read.
            sessions: permissions.includes("admin.users.sessions"),
            auditEvents: permissions.includes("admin.audit.read"),
            organizations: permissions.includes("admin.orgs.read"),
          },
          scope,
        )
      : Promise.resolve({} as OverviewActivity),
    // RBAC scoping (system vs. own-org, per-series visibility) is decided
    // server-side — shared with GET /api/administrator/metrics so the charts
    // and the API can never show different things to the same caller.
    access ? selectDashboardMetrics(access) : Promise.resolve(null),
  ]);

  const cards = visible
    .map((d) => toCard(d, metrics, t, locale))
    .filter((c): c is MetricCardProps => c !== null);

  const lists = buildActivityLists(activity, t, locale);
  const insights = dashboardMetrics ? buildInsights(dashboardMetrics, t, locale) : [];

  return (
    <section className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </header>

      {cards.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {cards.map((card) => (
            <MetricCard key={card.label} {...card} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t("metrics.none")}</p>
      )}

      {insights.length > 0 ? (
        <section aria-labelledby="insights-heading" className="space-y-4">
          <div className="space-y-1">
            <h2 id="insights-heading" className="text-base font-semibold">
              {t("insights.title")}
            </h2>
            <p className="text-muted-foreground text-sm">{t("insights.description")}</p>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {insights.map((insight) => (
              <Card key={insight.key} className="h-full">
                <CardHeader className="space-y-1 pb-2">
                  <CardTitle className="text-sm font-medium">{insight.title}</CardTitle>
                  <p className="text-muted-foreground text-xs">{insight.subtitle}</p>
                </CardHeader>
                <CardContent>
                  <MetricBarChart
                    data={insight.data}
                    caption={insight.title}
                    categoryHeader={insight.categoryHeader}
                    valueHeader={t("insights.table.count")}
                    emptyLabel={t("insights.empty")}
                    fill={insight.fill}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {lists.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {lists.map((list) => (
            <OverviewListCard key={list.title} {...list} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** A single chart descriptor: localized chrome plus its plotted series. */
interface InsightChart {
  key: string;
  title: string;
  subtitle: string;
  categoryHeader: string;
  data: MetricBarDatum[];
  fill: string;
}

/**
 * Maps the server-scoped {@link DashboardMetrics} to localized chart
 * descriptors. Only the series the caller is allowed to see are present on
 * `dashboardMetrics`, so this never re-decides visibility — it just shapes
 * what survived scoping. SUPERADMIN sees most-active-orgs (cross-org) plus
 * system registrations/logins and total audit-event volume; an org admin sees
 * only their org's series (and never the audit-volume chart).
 */
function buildInsights(
  dashboardMetrics: DashboardMetrics,
  t: Awaited<ReturnType<typeof getTranslations>>,
  locale: string,
): InsightChart[] {
  const dayLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  const daySeries = (series: { date: string; count: number }[]): MetricBarDatum[] =>
    series.map((d) => ({ label: dayLabel(d.date), value: d.count }));

  const charts: InsightChart[] = [];
  const isSystem = dashboardMetrics.scope === "system";

  if (dashboardMetrics.mostActiveOrgs) {
    charts.push({
      key: "mostActiveOrgs",
      title: t("insights.mostActiveOrgs.title"),
      subtitle: t("insights.mostActiveOrgs.subtitle", { days: dashboardMetrics.windowDays }),
      categoryHeader: t("insights.table.organization"),
      data: dashboardMetrics.mostActiveOrgs.map((o) => ({ label: o.name, value: o.count })),
      fill: "var(--chart-1)",
    });
  }

  if (dashboardMetrics.registrationsDaily) {
    charts.push({
      key: "registrations",
      title: t("insights.registrations.title"),
      subtitle: isSystem ? t("insights.registrations.system") : t("insights.registrations.org"),
      categoryHeader: t("insights.table.day"),
      data: daySeries(dashboardMetrics.registrationsDaily),
      fill: "var(--chart-2)",
    });
  }

  if (dashboardMetrics.loginsDaily) {
    charts.push({
      key: "logins",
      title: t("insights.logins.title"),
      subtitle: isSystem ? t("insights.logins.system") : t("insights.logins.org"),
      categoryHeader: t("insights.table.day"),
      data: daySeries(dashboardMetrics.loginsDaily),
      fill: "var(--chart-3)",
    });
  }

  // SUPERADMIN-only: present only when `selectDashboardMetrics` populated it
  // (system scope), so this chart never renders for an org admin.
  if (dashboardMetrics.auditEventsDaily) {
    charts.push({
      key: "auditEvents",
      title: t("insights.auditEvents.title"),
      subtitle: t("insights.auditEvents.system"),
      categoryHeader: t("insights.table.day"),
      data: daySeries(dashboardMetrics.auditEventsDaily),
      fill: "var(--chart-4)",
    });
  }

  return charts;
}

/**
 * Joins the permitted activity slices with their localized table
 * shapes. Each list renders only when its slice was fetched (i.e. the
 * caller holds the read permission for that area).
 */
function buildActivityLists(
  activity: OverviewActivity,
  t: Awaited<ReturnType<typeof getTranslations>>,
  locale: string,
): OverviewListCardProps[] {
  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  const time = (iso: string) => (
    <span className="text-muted-foreground whitespace-nowrap">{formatTime(iso)}</span>
  );

  const lists: OverviewListCardProps[] = [];

  if (activity.registrations) {
    lists.push({
      title: t("recent.registrationsTitle"),
      viewAllHref: "/app/administrator/users",
      viewAllLabel: t("recent.viewAll"),
      emptyLabel: t("recent.empty"),
      locale,
      headers: [t("recent.columns.user"), t("recent.columns.status"), t("recent.columns.created")],
      rows: activity.registrations.map((r) => ({
        key: r.id,
        cells: [
          <span key="user" className="block max-w-48 truncate" title={r.email}>
            {r.displayName ?? r.email}
          </span>,
          <Badge key="status" variant="outline">
            {r.status}
          </Badge>,
          time(r.createdAt),
        ],
      })),
    });
  }

  if (activity.sessions) {
    lists.push({
      title: t("recent.sessionsTitle"),
      emptyLabel: t("recent.empty"),
      locale,
      headers: [t("recent.columns.user"), t("recent.columns.ip"), t("recent.columns.signedIn")],
      rows: activity.sessions.map((s) => ({
        key: s.id,
        cells: [
          <span key="user" className="block max-w-48 truncate" title={s.userEmail}>
            {s.userName || s.userEmail}
          </span>,
          <code key="ip" className="text-muted-foreground">
            {s.ipAddress ?? "—"}
          </code>,
          time(s.createdAt),
        ],
      })),
    });
  }

  if (activity.auditEvents) {
    lists.push({
      title: t("recent.auditTitle"),
      viewAllHref: "/app/administrator/audit",
      viewAllLabel: t("recent.viewAll"),
      emptyLabel: t("recent.empty"),
      locale,
      headers: [t("recent.columns.event"), t("recent.columns.outcome"), t("recent.columns.when")],
      rows: activity.auditEvents.map((e) => ({
        key: e.id,
        cells: [
          <span key="event" className="block max-w-56 truncate" title={e.email ?? undefined}>
            {e.eventType}
          </span>,
          <Badge key="outcome" variant={e.outcome === "success" ? "outline" : "destructive"}>
            {e.outcome}
          </Badge>,
          time(e.createdAt),
        ],
      })),
    });
  }

  if (activity.organizations) {
    lists.push({
      title: t("recent.organizationsTitle"),
      viewAllHref: "/app/administrator/organizations",
      viewAllLabel: t("recent.viewAll"),
      emptyLabel: t("recent.empty"),
      locale,
      headers: [t("recent.columns.name"), t("recent.columns.slug"), t("recent.columns.created")],
      rows: activity.organizations.map((o) => ({
        key: o.id,
        cells: [
          <span key="name" className="block max-w-48 truncate">
            {o.name}
          </span>,
          <code key="slug" className="text-muted-foreground">
            {o.slug}
          </code>,
          time(o.createdAt),
        ],
      })),
    });
  }

  return lists;
}

/** Joins a descriptor with its metric slice into MetricCard props. */
function toCard(
  descriptor: (typeof METRIC_DESCRIPTORS)[number],
  metrics: OverviewMetrics,
  t: Awaited<ReturnType<typeof getTranslations>>,
  locale: string,
): MetricCardProps | null {
  const base = {
    icon: descriptor.icon,
    href: descriptor.href,
    locale,
  } as const;

  switch (descriptor.id) {
    case "users":
      return metrics.users
        ? {
            ...base,
            label: t("metrics.users"),
            value: metrics.users.total,
            hint: t("metrics.usersHint", {
              active: metrics.users.active,
              pending: metrics.users.pendingApproval,
            }),
          }
        : null;
    case "organizations":
      return metrics.organizations
        ? { ...base, label: t("metrics.organizations"), value: metrics.organizations.total }
        : null;
    case "roles":
      return metrics.roles
        ? { ...base, label: t("metrics.roles"), value: metrics.roles.total }
        : null;
    case "permissions":
      return metrics.permissions
        ? { ...base, label: t("metrics.permissions"), value: metrics.permissions.total }
        : null;
    case "enterpriseApps":
      return metrics.enterpriseApps
        ? {
            ...base,
            label: t("metrics.enterpriseApps"),
            value: metrics.enterpriseApps.total,
            hint: t("metrics.enterpriseAppsHint", {
              available: metrics.enterpriseApps.available,
            }),
          }
        : null;
  }
}
