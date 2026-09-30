import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  actingOrganizationId,
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_STATUS,
} from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { banBetterAuthUser, type BanSnapshot } from "@/lib/admin/auth-admin.server";
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
import { guardAppliedBan } from "@/lib/admin/user-actions.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/ban
 *
 * Better Auth ban (`banBetterAuthUser`), for a cookie or a bearer caller
 * alike (F-13). Banning oneself is refused. Reason is required (UX: ban without
 * justification is the kind of action ops will want to look up later);
 * `expiresInSeconds` is optional — omit for indefinite per Better Auth
 * semantics. The reason is persisted in the audit row's `reason` column
 * (docs/admin-manager.md §12). A ban that would leave no superadmin able to
 * sign in is undone and answered 409 `last_superadmin` (REVOKE-2, F-56). A
 * soft-deleted user is 409 `use_restore` (F-57), and an agent service
 * account, which has no Better Auth user, 409
 * `not_applicable_to_service_account` (F-77).
 *
 * Caller MUST hold `admin.users.ban`.
 */
const banSchema = z
  .object({
    reason: z.string().min(1).max(500),
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 24 * 365)
      .optional(),
  })
  .strict();

export const POST = withAdminRoute(async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.ban");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.ban",
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
  const outranked = await refuseOutrankingTarget(guard, target, request, "ban");
  if (outranked) return outranked;

  // AUTHZ-2: a Better Auth ban locks the account out of EVERY org. A non-
  // SUPERADMIN may not ban a user shared with other orgs (it would lock them
  // out of tenants the actor does not administer); that is SUPERADMIN-only.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return adminErrorResponse("not_found", 404, request);
  if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
    return refuseSharedTarget(guard, target, request, "ban");
  }

  // F-77: an agent service account has no Better Auth user to ban, so this was
  // a 502. It is stopped by a block here, or revoked in the Agents console.
  if (isAgentServiceAccount(target)) {
    return adminErrorResponse(SERVICE_ACCOUNT_ERROR, SERVICE_ACCOUNT_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  // F-57: a soft-deleted account is already banned indefinitely, and only
  // restore may change that ban (a timed ban here would make it lapse).
  if (mustUseRestore(target)) {
    return adminErrorResponse(USE_RESTORE_ERROR, USE_RESTORE_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = banSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  let previousBan: BanSnapshot | null;
  try {
    ({ previousBan } = await banBetterAuthUser({
      userId: target.betterAuthUserId,
      banReason: parsed.data.reason,
      banExpiresIn: parsed.data.expiresInSeconds,
      actorBetterAuthUserId: guard.betterAuthUserId,
    }));
  } catch (err) {
    await auditUserAction("admin.user.ban_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: actingOrganizationId(guard.access),
      email: target.primaryEmail,
      reason: "auth_ban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_ban_failed", 502, request, { cause: err });
  }

  // REVOKE-2 (F-56): banning the last superadmin who can still sign in would
  // leave nobody able to administer the platform, and the rank guard above
  // exempts a SUPERADMIN actor outright. The check follows the ban (see
  // `guardAppliedBan`), which undoes it (back to `previousBan`, F-57) and
  // audits the refusal.
  const guarded = await guardAppliedBan(
    target,
    {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: actingOrganizationId(guard.access),
      requestId: guard.requestId,
    },
    previousBan,
  );
  if (!guarded.ok) {
    return guarded.error === LAST_SUPERADMIN_ERROR
      ? adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
          requestId: guard.requestId,
        })
      : adminErrorResponse("internal_error", 500, request, {
          cause: guarded.cause,
          requestId: guard.requestId,
        });
  }

  await auditUserAction("admin.user.banned", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: actingOrganizationId(guard.access),
    email: target.primaryEmail,
    reason: parsed.data.reason,
    metadata: { expiresInSeconds: parsed.data.expiresInSeconds ?? null },
  });

  return NextResponse.json({ ok: true });
});
