import "server-only";
import { db } from "@/db/database";

/**
 * Query layer for the Administrator overview dashboard
 * (docs/admin-manager.md §8.1).
 *
 * Pure data access — no permission checks, no formatting, no i18n.
 * The page maps the caller's permissions to the `include` flags and
 * owns presentation; this module owns counting. Adding a metric means
 * adding a slice here and a card descriptor in the page.
 */

export interface OverviewUsersMetric {
  total: number;
  active: number;
  pendingApproval: number;
}

export interface OverviewCountMetric {
  total: number;
}

export interface OverviewEnterpriseAppsMetric {
  total: number;
  available: number;
}

export interface OverviewMetrics {
  users?: OverviewUsersMetric;
  organizations?: OverviewCountMetric;
  roles?: OverviewCountMetric;
  permissions?: OverviewCountMetric;
  enterpriseApps?: OverviewEnterpriseAppsMetric;
}

export interface OverviewMetricsInclude {
  users: boolean;
  organizations: boolean;
  roles: boolean;
  permissions: boolean;
  enterpriseApps: boolean;
}

/** pg `count()` arrives as a string; normalize defensively. */
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function countUsers(): Promise<OverviewUsersMetric> {
  const rows = await db
    .selectFrom("app_users")
    .select(["status", (eb) => eb.fn.countAll<string>().as("count")])
    .groupBy("status")
    .execute();

  const byStatus = new Map(rows.map((r) => [r.status, toCount(r.count)]));
  const total = rows.reduce((sum, r) => sum + toCount(r.count), 0);
  return {
    total,
    active: byStatus.get("active") ?? 0,
    pendingApproval: byStatus.get("pending_approval") ?? 0,
  };
}

async function countOrganizations(): Promise<OverviewCountMetric> {
  const row = await db
    .selectFrom("app_organizations")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirst();
  return { total: toCount(row?.count) };
}

async function countRoles(): Promise<OverviewCountMetric> {
  const row = await db
    .selectFrom("app_roles")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirst();
  return { total: toCount(row?.count) };
}

async function countPermissions(): Promise<OverviewCountMetric> {
  const row = await db
    .selectFrom("app_permissions")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirst();
  return { total: toCount(row?.count) };
}

async function countEnterpriseApps(): Promise<OverviewEnterpriseAppsMetric> {
  const rows = await db
    .selectFrom("app_enterprise_applications")
    .select(["status", (eb) => eb.fn.countAll<string>().as("count")])
    .groupBy("status")
    .execute();

  const total = rows.reduce((sum, r) => sum + toCount(r.count), 0);
  const available = toCount(rows.find((r) => r.status === "available")?.count);
  return { total, available };
}

/**
 * Loads the requested metric slices in parallel. Slices the caller is
 * not permitted to see are never queried (the page decides via the
 * `include` flags), so a narrowly-scoped admin costs only the queries
 * their permissions warrant.
 */
export async function getAdministratorOverviewMetrics(
  include: OverviewMetricsInclude,
): Promise<OverviewMetrics> {
  const [users, organizations, roles, permissions, enterpriseApps] = await Promise.all([
    include.users ? countUsers() : undefined,
    include.organizations ? countOrganizations() : undefined,
    include.roles ? countRoles() : undefined,
    include.permissions ? countPermissions() : undefined,
    include.enterpriseApps ? countEnterpriseApps() : undefined,
  ]);

  return { users, organizations, roles, permissions, enterpriseApps };
}
