import "server-only";
import {
  hasCrossOrgReach,
  isSuperadmin,
  resolveOrgScope,
  type AccessLike,
} from "@/lib/admin/access-scope.server";
import {
  DEFAULT_WINDOW_DAYS,
  dailyAuditEvents,
  dailyLogins,
  dailyRegistrations,
  signupsPerOrg,
  type DailyCount,
  type DayWindow,
  type OrgSignupCount,
} from "@/lib/admin/metrics.server";
import { logger } from "@/lib/observability/logger.server";

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
 *   - ORG-BOUND CREDENTIAL (MACHINE-2) → the ORG ADMIN payload for its bound
 *     org, even when its owner is a global superuser. A minted credential is
 *     confined to the tenant it was minted in, so it never reports
 *     platform-wide activity.
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

export interface DashboardMetricsOptions {
  /**
   * IANA zone whose calendar days the daily series count. Default `"UTC"`,
   * what the JSON API reports. The Administrator overview passes the viewer's
   * saved zone (F-37) so its charts agree with the activity lists beside them.
   */
  timeZone?: string;
}

export async function selectDashboardMetrics(
  access: AccessLike,
  options: DashboardMetricsOptions = {},
): Promise<DashboardMetrics> {
  const timeZone = options.timeZone ?? "UTC";
  try {
    return await selectInZone(access, { timeZone });
  } catch (error) {
    // Postgres keeps its own tz database. A zone this runtime's ICU accepted
    // (and so the preferences form offered) can be missing from an older
    // server's, and Postgres then rejects the query with 22023
    // (invalid_parameter_value: time zone "…" not recognized). Count UTC days
    // rather than fail the Administrator overview over a display preference.
    if (timeZone === "UTC" || !isUnknownTimeZoneError(error)) throw error;
    logger.warn({ timeZone }, "dashboard metrics: zone unknown to the database; counting UTC days");
    return selectInZone(access, { timeZone: "UTC" });
  }
}

function isUnknownTimeZoneError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "22023"
  );
}

async function selectInZone(access: AccessLike, range: DayWindow): Promise<DashboardMetrics> {
  // A SUPERADMIN holds every capability via the marker, so the literal
  // permission keys are implied; an org admin needs them explicitly. These two
  // are CAPABILITY questions ("may this principal see logins at all?"), not
  // tenant-boundary questions, so they stay on `isSuperadmin` — an org-bound
  // superuser credential really does hold `admin.audit.read` in its own org.
  const canSeeRegistrations =
    isSuperadmin(access) || access.permissions.includes("admin.users.read");
  const canSeeLogins = isSuperadmin(access) || access.permissions.includes("admin.audit.read");

  // MACHINE-2: the SYSTEM branch below is cross-tenant by construction —
  // `signupsPerOrg()` / the un-scoped `dailyRegistrations()` / `dailyLogins()` /
  // `dailyAuditEvents()` read EVERY org. An org-bound credential must not enter
  // it, or a superuser-owned key minted in org A would report the whole
  // platform's activity through `GET /api/administrator/metrics`. A bound
  // superuser falls through to the org branch and gets its own tenant's
  // numbers, exactly like an org admin.
  if (hasCrossOrgReach(access)) {
    const [mostActiveOrgs, registrationsDaily, loginsDaily, auditEventsDaily] = await Promise.all([
      signupsPerOrg(range),
      canSeeRegistrations ? dailyRegistrations(undefined, range) : Promise.resolve(undefined),
      canSeeLogins ? dailyLogins(undefined, range) : Promise.resolve(undefined),
      // Total audit volume is SUPERADMIN-only (no org-scoped variant) and is
      // audit data, so it follows the same `admin.audit.read` capability as
      // logins — implied here by the superuser marker.
      canSeeLogins ? dailyAuditEvents(range) : Promise.resolve(undefined),
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
    canSeeRegistrations ? dailyRegistrations(orgId, range) : Promise.resolve(undefined),
    canSeeLogins ? dailyLogins(orgId, range) : Promise.resolve(undefined),
  ]);
  return {
    scope: "organization",
    organizationId: orgId,
    windowDays: DEFAULT_WINDOW_DAYS,
    ...(registrationsDaily ? { registrationsDaily } : {}),
    ...(loginsDaily ? { loginsDaily } : {}),
  };
}
