import type { NextRequest } from "next/server";
import { z } from "zod";
import { actingOrganizationId, hasCrossOrgReach } from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { mustUseRestore } from "@/lib/admin/deactivated-user";
import { adminErrorResponse, adminJsonResponse } from "@/lib/http/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
import { refuseWithoutCrossOrgReach } from "@/lib/admin/refusals.server";
import {
  isAgentServiceAccount,
  SERVICE_ACCOUNT_ERROR,
  SERVICE_ACCOUNT_STATUS,
} from "@/lib/admin/service-account";
import {
  isNotDeactivatedError,
  pseudonymiseUser,
  type ErasureResult,
} from "@/lib/admin/user-erasure.server";
import { isResolvedUserResponse, isUuid, resolveTargetUser } from "@/lib/admin/user-target.server";
import { revokeBearerCredentialsOf } from "@/lib/api-auth/credential-eviction.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/erase
 *
 * F-151: erase a SOFT-DELETED user's personal data (GDPR Art. 17, PIPEDA)
 * without breaking the audit trail. Soft-delete first (`DELETE /users/[id]`):
 * it bans the account, blocks every membership and revokes its credentials.
 * Erasure then:
 *   1. revokes the account's bearer credentials again
 *      (`revokeBearerCredentialsOf`, `owner_deleted`), audited and through the
 *      issuance fence, in case the soft-delete's revocation failed or a key was
 *      minted for the account since;
 *   2. runs `app_users_pseudonymise` (migration 0008, `pseudonymiseUser`): the
 *      addresses become `erased+<id>@erased.invalid`, the name and picture go,
 *      every session and sign-in credential is deleted, mail addressed to them
 *      is blanked, and the IP address and user agent of their own requests are
 *      cleared from the audit log, as the table owner through the trigger's
 *      narrow exemption, so the trail keeps every row;
 *   3. writes `admin.user.erased` with the counts, under the pseudonym.
 * It cannot be undone: restore refuses an erased account (409 `user_erased`).
 *
 * SUPERADMIN-only, on top of `admin.users.delete`: the change is irreversible
 * and reaches the account in every organization, so it takes cross-org reach
 * (MACHINE-2: an org-bound superuser credential does not have it), like the
 * Better Auth platform role. The refusal is audited (F-58). The body must name
 * the account's current address (`confirmEmail`, compared case-insensitively),
 * the API half of the console's double confirmation, so a mistyped id cannot
 * erase the wrong person. Not for an MCP agent's service account (409
 * `not_applicable_to_service_account`, F-77): it holds no personal data, and
 * the Agents console owns its lifecycle. Anything but a soft-deleted account is
 * 409 `not_deactivated`, as for restore. Erasing an erased account again is
 * accepted and changes nothing (`alreadyErased: true`).
 */
const eraseSchema = z.object({ confirmEmail: z.string().min(1).max(320) }).strict();

export const POST = withAdminRoute(async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  if (!hasCrossOrgReach(guard.access)) {
    const { id: requestedId } = await ctx.params;
    return refuseWithoutCrossOrgReach(guard, request, "user_erase", {
      requestedTargetId: isUuid(requestedId) ? requestedId : null,
    });
  }

  const limited = enforceRateLimit(
    "admin.users.erase",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  if (isAgentServiceAccount(target)) {
    return adminErrorResponse(SERVICE_ACCOUNT_ERROR, SERVICE_ACCOUNT_STATUS, request, {
      requestId: guard.requestId,
    });
  }
  if (!mustUseRestore(target)) {
    return adminErrorResponse("not_deactivated", 409, request, { requestId: guard.requestId });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request, { requestId: guard.requestId });
  }
  const parsed = eraseSchema.safeParse(json);
  if (
    !parsed.success ||
    parsed.data.confirmEmail.trim().toLowerCase() !== target.primaryEmail.toLowerCase()
  ) {
    return adminErrorResponse("invalid_body", 400, request, { requestId: guard.requestId });
  }

  const organizationId = actingOrganizationId(guard.access);
  let result: ErasureResult;
  try {
    await revokeBearerCredentialsOf({
      betterAuthUserId: target.betterAuthUserId,
      trigger: "owner_deleted",
      actorBetterAuthUserId: guard.betterAuthUserId,
      revokedByAppUserId: guard.access.appUserId,
      request,
      requestId: guard.requestId,
    });
    result = await pseudonymiseUser(target.appUserId);
  } catch (err) {
    // A restore committed after the status check above: the function refused
    // the account under its row lock, and nothing was erased.
    if (isNotDeactivatedError(err)) {
      return adminErrorResponse("not_deactivated", 409, request, { requestId: guard.requestId });
    }
    await auditUserAction("admin.user.erase_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId,
      email: target.primaryEmail,
      requestId: guard.requestId,
      reason: "erase_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("erase_failed", 500, request, {
      cause: err,
      requestId: guard.requestId,
    });
  }

  // Under the pseudonym: the row outlives the address it would otherwise keep.
  const { pseudonym, alreadyErased, ...counts } = result;
  await auditUserAction("admin.user.erased", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId,
    email: pseudonym,
    requestId: guard.requestId,
    metadata: { alreadyErased, counts },
  });

  return adminJsonResponse({ ok: true, alreadyErased }, request, { requestId: guard.requestId });
});
