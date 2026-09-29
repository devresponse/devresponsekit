import type { NextRequest } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  actingOrganizationId,
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
} from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { restoreBetterAuthBan } from "@/lib/admin/auth-admin.server";
import { mustUseRestore } from "@/lib/admin/deactivated-user";
import { adminErrorResponse, adminJsonResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { refuseSharedTarget } from "@/lib/admin/refusals.server";
import {
  isAgentServiceAccount,
  SERVICE_ACCOUNT_ERROR,
  SERVICE_ACCOUNT_STATUS,
} from "@/lib/admin/service-account";
import { recordedPriorBan, restoreSnapshottedMemberships } from "@/lib/admin/user-actions.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/restore
 *
 * Inverse of the soft-delete (docs/admin-manager.md §8.1):
 *   1. Lift the soft-delete's Better Auth ban, or put back the earlier ban it
 *      replaced (F-57). The API keys and OAuth clients the soft-delete revoked
 *      stay revoked (I-19).
 *   2. Set `app_users.status` back to `pending_approval` and clear the
 *      `deactivated_*` columns. We deliberately do NOT auto-restore to
 *      `active` — an admin should re-approve via the status endpoint so
 *      the approval intent is captured in audit.
 *   3. Restore each membership to the status snapshotted in
 *      `pre_deactivation_status` when the soft-delete cascade ran, except
 *      that an `active` one comes back `pending_approval`, so each org
 *      approves its own membership again (F-152,
 *      `restoreSnapshottedMemberships`). Without this step a restored user
 *      would have all org memberships permanently `'blocked'` and could
 *      not access anything.
 *
 * Caller MUST hold `admin.users.delete` (same permission gates both
 * directions of the soft-delete lifecycle, docs/admin-manager.md §8.1). An
 * agent service account is 409 `not_applicable_to_service_account` (F-77).
 */
export const POST = withAdminRoute(async function POST(request: NextRequest, ctx: RouteContext) {
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
    return refuseSharedTarget(guard, target, request, "restore");
  }

  // F-77: an agent service account cannot have been soft-deleted (that is
  // refused too), and one the registration reaper expired has a revoked
  // client, so there is nothing to restore; with no Better Auth user, the
  // unban below was a 502.
  if (isAgentServiceAccount(target)) {
    return adminErrorResponse(SERVICE_ACCOUNT_ERROR, SERVICE_ACCOUNT_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  if (!mustUseRestore(target)) {
    return adminErrorResponse("not_deactivated", 409, request, {
      requestId: guard.requestId,
    });
  }

  // F-57: put back the ban the soft-delete replaced (a ban for abuse, say), or
  // lift its ban when there was none. Undoing a delete (`admin.users.delete`)
  // must not lift a ban its holder may not lift (`admin.users.ban`). The
  // soft-delete's audit row records that ban; reading it is a database read,
  // so it stays outside the `auth_unban_failed` handling and a failure is the
  // generic 500.
  const priorBan = await recordedPriorBan(target.appUserId);
  let banned: boolean;
  try {
    ({ banned } = await restoreBetterAuthBan(target.betterAuthUserId, priorBan));
  } catch (err) {
    await auditUserAction("admin.user.restore_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: actingOrganizationId(guard.access),
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

    await restoreSnapshottedMemberships(target.appUserId, trx);
  });

  await auditUserAction("admin.user.restored", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: actingOrganizationId(guard.access),
    email: target.primaryEmail,
    requestId: guard.requestId,
    metadata: { banReinstated: banned },
  });

  return adminJsonResponse({ ok: true, status: "pending_approval" }, request, {
    requestId: guard.requestId,
  });
});
