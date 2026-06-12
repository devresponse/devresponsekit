import "server-only";
import { db } from "@/db/database";
import { toDate } from "@/lib/db-types";

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

/* -------------------------------------------------------------------------- */
/*  Recent activity (the dashboard's second tier)                             */
/* -------------------------------------------------------------------------- */

const ACTIVITY_LIMIT = 10;

export interface RecentRegistration {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  /** ISO timestamp — normalized at the query boundary. */
  createdAt: string;
}

export interface RecentLoginSession {
  id: string;
  userEmail: string;
  userName: string;
  ipAddress: string | null;
  createdAt: string;
}

export interface RecentAuditEvent {
  id: string;
  eventType: string;
  outcome: string;
  email: string | null;
  createdAt: string;
}

export interface RecentOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
}

export interface OverviewActivity {
  registrations?: RecentRegistration[];
  sessions?: RecentLoginSession[];
  auditEvents?: RecentAuditEvent[];
  organizations?: RecentOrganization[];
}

export interface OverviewActivityInclude {
  registrations: boolean;
  sessions: boolean;
  auditEvents: boolean;
  organizations: boolean;
}

async function listRecentRegistrations(): Promise<RecentRegistration[]> {
  const rows = await db
    .selectFrom("app_users")
    .select(["id", "primary_email", "display_name", "status", "created_at"])
    .orderBy("created_at", "desc")
    .limit(ACTIVITY_LIMIT)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    email: r.primary_email,
    displayName: r.display_name,
    status: r.status,
    createdAt: toDate(r.created_at).toISOString(),
  }));
}

async function listRecentSessions(): Promise<RecentLoginSession[]> {
  // Better Auth owns the `session`/`user` tables; this is a read-only
  // reporting join (see the schema note in app-schema.ts).
  const rows = await db
    .selectFrom("session")
    .innerJoin("user", "user.id", "session.userId")
    .select([
      "session.id as id",
      "user.email as userEmail",
      "user.name as userName",
      "session.ipAddress as ipAddress",
      "session.createdAt as createdAt",
    ])
    .orderBy("session.createdAt", "desc")
    .limit(ACTIVITY_LIMIT)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    userEmail: r.userEmail,
    userName: r.userName,
    ipAddress: r.ipAddress,
    createdAt: toDate(r.createdAt).toISOString(),
  }));
}

async function listRecentAuditEvents(): Promise<RecentAuditEvent[]> {
  const rows = await db
    .selectFrom("app_audit_events")
    .select(["id", "event_type", "outcome", "email", "created_at"])
    .orderBy("created_at", "desc")
    .limit(ACTIVITY_LIMIT)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    outcome: r.outcome,
    email: r.email,
    createdAt: toDate(r.created_at).toISOString(),
  }));
}

async function listRecentOrganizations(): Promise<RecentOrganization[]> {
  const rows = await db
    .selectFrom("app_organizations")
    .select(["id", "name", "slug", "status", "created_at"])
    .orderBy("created_at", "desc")
    .limit(ACTIVITY_LIMIT)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    createdAt: toDate(r.created_at).toISOString(),
  }));
}

/**
 * Loads the requested recent-activity lists in parallel — same
 * permission-driven `include` contract as the metric slices: excluded
 * lists are never queried.
 */
export async function getAdministratorOverviewActivity(
  include: OverviewActivityInclude,
): Promise<OverviewActivity> {
  const [registrations, sessions, auditEvents, organizations] = await Promise.all([
    include.registrations ? listRecentRegistrations() : undefined,
    include.sessions ? listRecentSessions() : undefined,
    include.auditEvents ? listRecentAuditEvents() : undefined,
    include.organizations ? listRecentOrganizations() : undefined,
  ]);

  return { registrations, sessions, auditEvents, organizations };
}
