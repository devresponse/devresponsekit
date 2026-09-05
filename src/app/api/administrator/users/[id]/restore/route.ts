import type { NextRequest } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
} from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { unbanBetterAuthUser } from "@/lib/admin/auth-admin.server";
import { adminErrorResponse, adminJsonResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/restore
 *
 * Inverse of the soft-delete (docs/admin-manager.md §8.1):
 *   1. Unban the Better Auth user.
 *   2. Set `app_users.status` back to `pending_approval` and clear the
 *      `deactivated_*` columns. We deliberately do NOT auto-restore to
 *      `active` — an admin should re-approve via the status endpoint so
 *      the approval intent is captured in audit.
 *   3. Restore each membership to the status snapshotted in
 *      `pre_deactivation_status` when the soft-delete cascade ran, then
 *      clear the snapshot column. Without this step a restored user
 *      would have all org memberships permanently `'blocked'` and could
 *      not access anything.
 *
 * Caller MUST hold `admin.users.delete` (same permission gates both
 * directions of the soft-delete lifecycle, docs/admin-manager.md §8.1).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.restore",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  // Privilege ordering (review #7): a non-SUPERADMIN may not act on a target
  // who outranks them (a superadmin, or a more-privileged peer) — 403 + audit.
  const outranked = await refuseOutrankingTarget(guard, target, request, "restore");
  if (outranked) return outranked;

  // AUTHZ-2: restore reverses an account-global soft-delete. A non-SUPERADMIN
  // may not restore a user shared with other orgs (such a user can only have
  // been soft-deleted by a SUPERADMIN); that is SUPERADMIN-only.
  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return adminErrorResponse("not_found", 404, request, { requestId: guard.requestId });
  }
  if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  if (target.status !== "deactivated") {
    return adminErrorResponse("not_deactivated", 409, request, {
      requestId: guard.requestId,
    });
  }

  try {
    await unbanBetterAuthUser(target.betterAuthUserId, request);
  } catch (err) {
    await auditUserAction("admin.user.restore_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      requestId: guard.requestId,
      reason: "auth_unban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_unban_failed", 502, request, {
      cause: err,
      requestId: guard.requestId,
    });
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("app_users")
      .set({
        status: "pending_approval",
        status_reason: null,
        deactivated_at: null,
        deactivated_by: null,
        deactivated_reason: null,
        updated_at: sql`now()`,
      })
      .where("id", "=", target.appUserId)
      .execute();

    await trx
      .updateTable("app_organization_memberships")
      .set({
        status: sql`coalesce(pre_deactivation_status, status)`,
        pre_deactivation_status: null,
        updated_at: sql`now()`,
      })
      .where("app_user_id", "=", target.appUserId)
      .where("pre_deactivation_status", "is not", null)
      .execute();
  });

  await auditUserAction("admin.user.restored", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    requestId: guard.requestId,
  });

  return adminJsonResponse({ ok: true, status: "pending_approval" }, request, {
    requestId: guard.requestId,
  });
}
