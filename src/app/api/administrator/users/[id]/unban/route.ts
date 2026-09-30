import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  actingOrganizationId,
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
} from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { unbanBetterAuthUser } from "@/lib/admin/auth-admin.server";
import {
  mustUseRestore,
  USE_RESTORE_ERROR,
  USE_RESTORE_STATUS,
} from "@/lib/admin/deactivated-user";
import { adminErrorResponse } from "@/lib/http/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
import { refuseSharedTarget } from "@/lib/admin/refusals.server";
import {
  isAgentServiceAccount,
  SERVICE_ACCOUNT_ERROR,
  SERVICE_ACCOUNT_STATUS,
} from "@/lib/admin/service-account";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/unban
 *
 * Inverse of {@link ./../ban}. No body required. Caller MUST hold
 * `admin.users.ban`. A soft-deleted user is 409 `use_restore` (F-57), and an
 * agent service account 409 `not_applicable_to_service_account` (F-77).
 */
export const POST = withAdminRoute(async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.ban");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.unban",
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
  const outranked = await refuseOutrankingTarget(guard, target, request, "unban");
  if (outranked) return outranked;

  // AUTHZ-2: unban restores account-global access. A non-SUPERADMIN may not
  // unban a user shared with other orgs (a shared user can only have been
  // banned by a SUPERADMIN in the first place); that is SUPERADMIN-only.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return adminErrorResponse("not_found", 404, request);
  if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
    return refuseSharedTarget(guard, target, request, "unban");
  }

  // F-77: an agent service account has no Better Auth user, so no ban to lift
  // (this was a 502).
  if (isAgentServiceAccount(target)) {
    return adminErrorResponse(SERVICE_ACCOUNT_ERROR, SERVICE_ACCOUNT_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  // F-57: lifting a soft-deleted account's ban would let Better Auth issue it
  // sessions again while the app still reads it as deleted. Restore lifts it,
  // together with the deactivation.
  if (mustUseRestore(target)) {
    return adminErrorResponse(USE_RESTORE_ERROR, USE_RESTORE_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  try {
    await unbanBetterAuthUser(target.betterAuthUserId);
  } catch (err) {
    await auditUserAction("admin.user.unban_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: actingOrganizationId(guard.access),
      email: target.primaryEmail,
      reason: "auth_unban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_unban_failed", 502, request, { cause: err });
  }

  await auditUserAction("admin.user.unbanned", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: actingOrganizationId(guard.access),
    email: target.primaryEmail,
  });

  return NextResponse.json({ ok: true });
});
