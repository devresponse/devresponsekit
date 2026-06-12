import { getTranslations } from "next-intl/server";
import { getAdministratorOverviewMetrics, type OverviewMetrics } from "@/lib/admin/overview.server";
import { ANY_ADMIN_PERMISSION, checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { MetricCard, type MetricCardProps } from "./_components/metric-card";

export const dynamic = "force-dynamic";

/**
 * Administrator overview dashboard (docs/admin-manager.md §8.1).
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
  const permissions = typeof guard === "string" ? [] : guard.access.permissions;

  const visible = METRIC_DESCRIPTORS.filter((d) => permissions.includes(d.permission));
  const visibleIds = new Set<MetricId>(visible.map((d) => d.id));

  const metrics = await getAdministratorOverviewMetrics({
    users: visibleIds.has("users"),
    organizations: visibleIds.has("organizations"),
    roles: visibleIds.has("roles"),
    permissions: visibleIds.has("permissions"),
    enterpriseApps: visibleIds.has("enterpriseApps"),
  });

  const cards = visible
    .map((d) => toCard(d, metrics, t, locale))
    .filter((c): c is MetricCardProps => c !== null);

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
    </section>
  );
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
