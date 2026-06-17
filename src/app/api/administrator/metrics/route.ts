import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { selectDashboardMetrics } from "@/lib/admin/dashboard-metrics.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/metrics
 *
 * Role-scoped dashboard metrics for the last 7 days. The SERVER decides what
 * the caller may see — an org admin never receives system-wide or other-org
 * data:
 *   - SUPERADMIN  → most-active-orgs + system daily registrations + system
 *     daily logins.
 *   - ORG ADMIN   → daily registrations + logins for THEIR active org only.
 *
 * Gated on `admin.users.read` (registrations are the core metric, matching the
 * dashboard's registration tile); the login series additionally requires
 * `admin.audit.read` since logins derive from audit events. The actual
 * scoping/visibility decision lives in {@link selectDashboardMetrics}, shared
 * with the server-rendered dashboard so API and UI cannot diverge.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.users.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  return NextResponse.json(await selectDashboardMetrics(guard.access));
}
