import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  actingOrganizationId,
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
  scopeOrganizationId,
} from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/http/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_EXPORT_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
import { refuseSharedTarget } from "@/lib/admin/refusals.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";
import { exportCounts, exportFilename } from "@/lib/user-data/export-shape";
import { buildUserDataExport } from "@/lib/user-data/export.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/users/[id]/export (F-151)
 *
 * One user's data as a JSON download, for an administrator answering
 * that person's access request. The document is the one the person downloads
 * themselves (`GET /api/account/export`, `buildUserDataExport`).
 *
 * Caller MUST hold `admin.users.export` (migration 0008): the document
 * aggregates what several reads show one at a time (the account, its
 * sessions, its credentials, the audit trail), so it is its own grant rather
 * than riding on any one of them. The target guards are the ones for the other
 * account-level actions: the rank guard (an org admin may not export a
 * superadmin or a more-privileged peer) and the AUTHZ-2 shared-target rule (a
 * user who belongs to other organizations too is SUPERADMIN-only, because
 * their document is about those tenants as well). An organization
 * administrator's export is confined to their organization's rows of the
 * organization-attributed sections (`organizationScope` in the document); a
 * superadmin's covers the whole account.
 *
 * Rate-limited on the export tier and audited as `admin.user.data_exported`
 * with the section sizes, never the data.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.export");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.export",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_EXPORT_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  const outranked = await refuseOutrankingTarget(guard, target, request, "data_export");
  if (outranked) return outranked;

  const scope = resolveOrgScope(guard.access);
  if (!scope) return adminErrorResponse("not_found", 404, request, { requestId: guard.requestId });
  if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
    return refuseSharedTarget(guard, target, request, "data_export");
  }

  const doc = await buildUserDataExport(target.appUserId, {
    organizationId: scopeOrganizationId(scope),
  });
  if (!doc) return adminErrorResponse("not_found", 404, request, { requestId: guard.requestId });

  await auditUserAction("admin.user.data_exported", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: actingOrganizationId(guard.access),
    email: target.primaryEmail,
    requestId: guard.requestId,
    metadata: {
      counts: exportCounts(doc),
      organizationScope: doc.organizationScope,
      auditEventsTruncated: doc.auditEventsTruncated,
    },
  });

  return new NextResponse(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(doc)}"`,
      "cache-control": "no-store",
      "x-request-id": guard.requestId,
    },
  });
});
