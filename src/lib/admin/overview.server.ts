import "server-only";
import { db } from "@/db/database";
import type { OrgScope } from "@/lib/admin/access-scope.server";
import { toDate } from "@/lib/db-types";

/**
 * Query layer for the Administrator overview dashboard.
 *
 * Pure data access — no permission checks, no formatting, no i18n.
 * The page maps the caller's permissions to the `include` flags and
 * owns presentation; this module owns counting. Adding a metric means
 * adding a slice here and a card descriptor in the page.
 *
 * ADR-0001 org scoping (single source of truth: `access-scope.server`).
 * Every metric and activity slice is bounded by the caller's {@link OrgScope}:
 *   - SUPERADMIN (`{ kind: "all" }`) → system-wide, unscoped.
 *   - ORG ADMIN  (`{ kind: "org" }`) → confined to that org only, exactly as
 *     the matching list routes scope (`organization_id = orgId`; tenant-less
 *     rows are SUPERADMIN-only). Users/sessions have no org column of their
 *     own, so they scope through `app_organization_memberships`.
 * A page must not call these with a `null` scope — that means "no resolvable
 * org" and the caller renders an empty dashboard instead.
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

async function countUsers(scope: OrgScope): Promise<OverviewUsersMetric> {
  let q = db
    .selectFrom("app_users")
    .select(["status", (eb) => eb.fn.countAll<string>().as("count")])
    .groupBy("status");

  // Users have no org column; their tenant IS their membership.
  if (scope.kind === "org") {
    const orgId = scope.organizationId;
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("app_organization_memberships as m")
          .select("m.id")
          .whereRef("m.app_user_id", "=", "app_users.id")
          .where("m.organization_id", "=", orgId),
      ),
    );
  }
  const rows = await q.execute();

  const byStatus = new Map(rows.map((r) => [r.status, toCount(r.count)]));
  const total = rows.reduce((sum, r) => sum + toCount(r.count), 0);
  return {
    total,
    active: byStatus.get("active") ?? 0,
    pendingApproval: byStatus.get("pending_approval") ?? 0,
  };
}

async function countOrganizations(scope: OrgScope): Promise<OverviewCountMetric> {
  let q = db.selectFrom("app_organizations").select((eb) => eb.fn.countAll<string>().as("count"));
  // An org admin's "organizations" is exactly their own org.
  if (scope.kind === "org") {
    q = q.where("id", "=", scope.organizationId);
  }
  const row = await q.executeTakeFirst();
  return { total: toCount(row?.count) };
}

async function countRoles(scope: OrgScope): Promise<OverviewCountMetric> {
  let q = db.selectFrom("app_roles").select((eb) => eb.fn.countAll<string>().as("count"));
  // Org-scoped roles only; global roles (organization_id IS NULL) are
  // SUPERADMIN-only — matching the roles list route.
  if (scope.kind === "org") {
    q = q.where("organization_id", "=", scope.organizationId);
  }
  const row = await q.executeTakeFirst();
  return { total: toCount(row?.count) };
}

async function countPermissions(): Promise<OverviewCountMetric> {
  // `app_permissions` is the platform-global permission CATALOG — it has no
  // organization_id and is identical for every tenant (reference data, not
  // tenant data), so it is not org-scoped and is the same for all admins.
  const row = await db
    .selectFrom("app_permissions")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirst();
  return { total: toCount(row?.count) };
}

async function countEnterpriseApps(scope: OrgScope): Promise<OverviewEnterpriseAppsMetric> {
  let q = db
    .selectFrom("app_enterprise_applications")
    .select(["status", (eb) => eb.fn.countAll<string>().as("count")])
    .groupBy("status");
  // Org-scoped apps only; global apps (organization_id IS NULL) are
  // SUPERADMIN-only — matching the enterprise-apps list route.
  if (scope.kind === "org") {
    q = q.where("organization_id", "=", scope.organizationId);
  }
  const rows = await q.execute();

  const total = rows.reduce((sum, r) => sum + toCount(r.count), 0);
  const available = toCount(rows.find((r) => r.status === "available")?.count);
  return { total, available };
}

/**
 * Loads the requested metric slices in parallel, each bounded by `scope`
 * (SUPERADMIN → system-wide; org admin → their org only). Slices the caller
 * is not permitted to see are never queried (the page decides via the
 * `include` flags), so a narrowly-scoped admin costs only the queries their
 * permissions warrant.
 */
export async function getAdministratorOverviewMetrics(
  include: OverviewMetricsInclude,
  scope: OrgScope,
): Promise<OverviewMetrics> {
  const [users, organizations, roles, permissions, enterpriseApps] = await Promise.all([
    include.users ? countUsers(scope) : undefined,
    include.organizations ? countOrganizations(scope) : undefined,
    include.roles ? countRoles(scope) : undefined,
    include.permissions ? countPermissions() : undefined,
    include.enterpriseApps ? countEnterpriseApps(scope) : undefined,
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

async function listRecentRegistrations(scope: OrgScope): Promise<RecentRegistration[]> {
  let q = db
    .selectFrom("app_users")
    .select(["id", "primary_email", "display_name", "status", "created_at"])
    .orderBy("created_at", "desc")
    .limit(ACTIVITY_LIMIT);

  // Users have no org column; confine to members of the caller's org.
  if (scope.kind === "org") {
    const orgId = scope.organizationId;
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("app_organization_memberships as m")
          .select("m.id")
          .whereRef("m.app_user_id", "=", "app_users.id")
          .where("m.organization_id", "=", orgId),
      ),
    );
  }
  const rows = await q.execute();

  return rows.map((r) => ({
    id: r.id,
    email: r.primary_email,
    displayName: r.display_name,
    status: r.status,
    createdAt: toDate(r.created_at).toISOString(),
  }));
}

async function listRecentSessions(scope: OrgScope): Promise<RecentLoginSession[]> {
  // Better Auth owns the `session`/`user` tables; this is a read-only
  // reporting join (see the schema note in app-schema.ts).
  let q = db
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
    .limit(ACTIVITY_LIMIT);

  // The session's owner must hold a membership in the caller's org. Bridge
  // Better Auth `user.id` → `app_users.better_auth_user_id` → memberships.
  if (scope.kind === "org") {
    const orgId = scope.organizationId;
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("app_users as au")
          .innerJoin("app_organization_memberships as m", "m.app_user_id", "au.id")
          .select("m.id")
          .whereRef("au.better_auth_user_id", "=", "user.id")
          .where("m.organization_id", "=", orgId),
      ),
    );
  }
  const rows = await q.execute();

  return rows.map((r) => ({
    id: r.id,
    userEmail: r.userEmail,
    userName: r.userName,
    ipAddress: r.ipAddress,
    createdAt: toDate(r.createdAt).toISOString(),
  }));
}

async function listRecentAuditEvents(scope: OrgScope): Promise<RecentAuditEvent[]> {
  let q = db
    .selectFrom("app_audit_events")
    .select(["id", "event_type", "outcome", "email", "created_at"])
    .orderBy("created_at", "desc")
    .limit(ACTIVITY_LIMIT);

  // Audit rows carry a direct organization_id; org admins see only their
  // org's events (tenant-less/system events stay SUPERADMIN-only) — matching
  // the audit list route.
  if (scope.kind === "org") {
    q = q.where("organization_id", "=", scope.organizationId);
  }
  const rows = await q.execute();

  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    outcome: r.outcome,
    email: r.email,
    createdAt: toDate(r.created_at).toISOString(),
  }));
}

async function listRecentOrganizations(scope: OrgScope): Promise<RecentOrganization[]> {
  let q = db
    .selectFrom("app_organizations")
    .select(["id", "name", "slug", "status", "created_at"])
    .orderBy("created_at", "desc")
    .limit(ACTIVITY_LIMIT);

  // An org admin only ever sees their own organization.
  if (scope.kind === "org") {
    q = q.where("id", "=", scope.organizationId);
  }
  const rows = await q.execute();

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    createdAt: toDate(r.created_at).toISOString(),
  }));
}

/**
 * Loads the requested recent-activity lists in parallel, each bounded by
 * `scope` (SUPERADMIN → system-wide; org admin → their org only) — same
 * permission-driven `include` contract as the metric slices: excluded lists
 * are never queried.
 */
export async function getAdministratorOverviewActivity(
  include: OverviewActivityInclude,
  scope: OrgScope,
): Promise<OverviewActivity> {
  const [registrations, sessions, auditEvents, organizations] = await Promise.all([
    include.registrations ? listRecentRegistrations(scope) : undefined,
    include.sessions ? listRecentSessions(scope) : undefined,
    include.auditEvents ? listRecentAuditEvents(scope) : undefined,
    include.organizations ? listRecentOrganizations(scope) : undefined,
  ]);

  return { registrations, sessions, auditEvents, organizations };
}
