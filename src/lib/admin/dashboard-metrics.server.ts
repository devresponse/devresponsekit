import "server-only";
import { isSuperadmin, resolveOrgScope } from "@/lib/admin/access-scope.server";
import {
  DEFAULT_WINDOW_DAYS,
  dailyAuditEvents,
  dailyLogins,
  dailyRegistrations,
  signupsPerOrg,
  type DailyCount,
  type OrgSignupCount,
} from "@/lib/admin/metrics.server";
import type { UserAccessContext } from "@/lib/auth-status";

/**
 * RBAC-scoped dashboard metric selection — the SINGLE place that decides
 * what a caller may see, shared by the JSON API (`/api/administrator/metrics`)
 * and the server-rendered Administrator dashboard so the two surfaces can
 * never drift:
 *   - SUPERADMIN → most-active-orgs (cross-org) + system-wide daily
 *     registrations + system-wide daily logins + system-wide daily audit-event
 *     volume (the last is SUPERADMIN-only — no org-scoped variant).
 *   - ORG ADMIN  → daily registrations + logins for THEIR active org only;
 *     never system-wide data and never another org's.
 *
 * Per-series visibility still follows the permission catalog: registrations
 * need `admin.users.read`, and logins + total audit volume need
 * `admin.audit.read` (a SUPERADMIN holds every capability by the marker, so all
 * are implied). The org
 * boundary itself comes from {@link resolveOrgScope}, the single source of
 * truth for tenant scoping — a `null` scope yields an empty org payload, never
 * "all".
 */
export interface DashboardMetrics {
  scope: "system" | "organization";
  organizationId: string | null;
  windowDays: number;
  /** SUPERADMIN only: signups per org (cross-org). */
  mostActiveOrgs?: OrgSignupCount[];
  /** Daily registrations — system-wide for SUPERADMIN, org-scoped for an org admin. */
  registrationsDaily?: DailyCount[];
  /** Daily logins (requires `admin.audit.read`). System or org per scope. */
  loginsDaily?: DailyCount[];
  /**
   * SUPERADMIN only: daily count of ALL audit events across every org
   * (requires `admin.audit.read`, implied by the superuser marker). No
   * org-scoped variant — org admins never receive this series.
   */
  auditEventsDaily?: DailyCount[];
}

type AccessLike = Pick<UserAccessContext, "permissions" | "organizationId">;

export async function selectDashboardMetrics(access: AccessLike): Promise<DashboardMetrics> {
  // A SUPERADMIN holds every capability via the marker, so the literal
  // permission keys are implied; an org admin needs them explicitly.
  const canSeeRegistrations =
    isSuperadmin(access) || access.permissions.includes("admin.users.read");
  const canSeeLogins = isSuperadmin(access) || access.permissions.includes("admin.audit.read");

  if (isSuperadmin(access)) {
    const [mostActiveOrgs, registrationsDaily, loginsDaily, auditEventsDaily] = await Promise.all([
      signupsPerOrg(),
      canSeeRegistrations ? dailyRegistrations() : Promise.resolve(undefined),
      canSeeLogins ? dailyLogins() : Promise.resolve(undefined),
      // Total audit volume is SUPERADMIN-only (no org-scoped variant) and is
      // audit data, so it follows the same `admin.audit.read` capability as
      // logins — implied here by the superuser marker.
      canSeeLogins ? dailyAuditEvents() : Promise.resolve(undefined),
    ]);
    return {
      scope: "system",
      organizationId: null,
      windowDays: DEFAULT_WINDOW_DAYS,
      mostActiveOrgs,
      ...(registrationsDaily ? { registrationsDaily } : {}),
      ...(loginsDaily ? { loginsDaily } : {}),
      ...(auditEventsDaily ? { auditEventsDaily } : {}),
    };
  }

  // Org admin: confine everything to their resolved org. A null scope means
  // "no resolvable org" → empty payload (never treated as "all").
  const scope = resolveOrgScope(access);
  if (!scope || scope.kind !== "org") {
    return { scope: "organization", organizationId: null, windowDays: DEFAULT_WINDOW_DAYS };
  }

  const orgId = scope.organizationId;
  const [registrationsDaily, loginsDaily] = await Promise.all([
    canSeeRegistrations ? dailyRegistrations(orgId) : Promise.resolve(undefined),
    canSeeLogins ? dailyLogins(orgId) : Promise.resolve(undefined),
  ]);
  return {
    scope: "organization",
    organizationId: orgId,
    windowDays: DEFAULT_WINDOW_DAYS,
    ...(registrationsDaily ? { registrationsDaily } : {}),
    ...(loginsDaily ? { loginsDaily } : {}),
  };
}
