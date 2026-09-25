import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { selectDashboardMetrics } from "@/lib/admin/dashboard-metrics.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/metrics
 *
 * Role-scoped dashboard metrics for the last 7 days. The SERVER decides what
 * the caller may see — an org admin never receives system-wide or other-org
 * data:
 *   - SUPERADMIN  → most-active-orgs + system daily registrations + system
 *     daily logins + system daily audit-event volume (SUPERADMIN-only, no
 *     org-scoped variant).
 *   - ORG ADMIN   → daily registrations + logins for THEIR active org only.
 *
 * Gated on `admin.users.read` (registrations are the core metric, matching the
 * dashboard's registration tile); the login series additionally requires
 * `admin.audit.read` since logins derive from audit events. The actual
 * scoping/visibility decision lives in {@link selectDashboardMetrics}, shared
 * with the server-rendered dashboard so API and UI cannot diverge.
 *
 * The daily series are UTC calendar days. The dashboard asks for the same
 * series in the viewer's saved zone instead (F-37). This route keeps UTC, so
 * a script reads the same days whoever's credential it runs under.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.users.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  return NextResponse.json(await selectDashboardMetrics(guard.access));
});
