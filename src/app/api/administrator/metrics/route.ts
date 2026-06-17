import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isSuperadmin, resolveOrgScope } from "@/lib/admin/access-scope.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import {
  DEFAULT_WINDOW_DAYS,
  dailyLogins,
  dailyRegistrations,
  signupsPerOrg,
  type DailyCount,
  type OrgSignupCount,
} from "@/lib/admin/metrics.server";

export const dynamic = "force-dynamic";

interface MetricsResponse {
  scope: "system" | "organization";
  organizationId: string | null;
  windowDays: number;
  /** SUPERADMIN only: signups per org (cross-org). */
  mostActiveOrgs?: OrgSignupCount[];
  /** Daily registrations — system-wide for SUPERADMIN, org-scoped for an org admin. */
  registrationsDaily?: DailyCount[];
  /** Daily logins (requires `admin.audit.read`). System or org per scope. */
  loginsDaily?: DailyCount[];
}

/**
 * GET /api/administrator/metrics
 *
 * Role-scoped dashboard metrics for the last `windowDays` (7) days. The
 * SERVER decides what the caller may see — an org admin never receives
 * system-wide or other-org data:
 *   - SUPERADMIN  → most-active-orgs + system daily registrations + system
 *     daily logins.
 *   - ORG ADMIN   → daily registrations + logins for THEIR active org only.
 *
 * Gated on `admin.users.read` (registrations are the core metric, matching
 * the dashboard's registration tile); login series additionally require
 * `admin.audit.read` since logins derive from audit events.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.users.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { access } = guard;
  const canSeeLogins = access.permissions.includes("admin.audit.read");

  if (isSuperadmin(access)) {
    const [mostActiveOrgs, registrationsDaily, loginsDaily] = await Promise.all([
      signupsPerOrg(),
      dailyRegistrations(),
      canSeeLogins ? dailyLogins() : Promise.resolve(undefined),
    ]);
    const body: MetricsResponse = {
      scope: "system",
      organizationId: null,
      windowDays: DEFAULT_WINDOW_DAYS,
      mostActiveOrgs,
      registrationsDaily,
      ...(loginsDaily ? { loginsDaily } : {}),
    };
    return NextResponse.json(body);
  }

  // Org admin: confine everything to their resolved org.
  const scope = resolveOrgScope(access);
  if (!scope || scope.kind !== "org") {
    return NextResponse.json({
      scope: "organization",
      organizationId: null,
      windowDays: DEFAULT_WINDOW_DAYS,
    } satisfies MetricsResponse);
  }

  const orgId = scope.organizationId;
  const [registrationsDaily, loginsDaily] = await Promise.all([
    dailyRegistrations(orgId),
    canSeeLogins ? dailyLogins(orgId) : Promise.resolve(undefined),
  ]);
  const body: MetricsResponse = {
    scope: "organization",
    organizationId: orgId,
    windowDays: DEFAULT_WINDOW_DAYS,
    registrationsDaily,
    ...(loginsDaily ? { loginsDaily } : {}),
  };
  return NextResponse.json(body);
}
