import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { performAdminStatusChange } from "@/lib/admin-status.server";
import {
  resolveOrgScope,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_STATUS,
} from "@/lib/admin/access-scope.server";
import { USE_RESTORE_ERROR, USE_RESTORE_STATUS } from "@/lib/admin/deactivated-user";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { refuseAgentActivation } from "@/lib/admin/refusals.server";
import { isAgentServiceAccount, mayActivateAgents } from "@/lib/admin/service-account";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/status
 *
 * Applies one of the status transitions (`approve` | `block` |
 * `suspend` | `reactivate`) to the target user via the shared
 * `performAdminStatusChange` core (docs/admin-manager.md §8.1, §13),
 * which also backs the bulk endpoint so both paths emit identical audit
 * events. A soft-deleted target is 409 `use_restore` (F-57). A block or
 * suspend that changes the account-wide status also ends the user's
 * sessions; if that fails the status stays applied and the answer is 502
 * `auth_revoke_all_failed`, safe to retry (F-147). Approving or
 * reactivating an agent service account also needs `admin.clients.manage`
 * (F-77, 403).
 */
const statusSchema = z
  .object({
    action: z.enum(["approve", "block", "suspend", "reactivate"]),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

const ACTION_TO_STATUS: Record<
  z.infer<typeof statusSchema>["action"],
  {
    newStatus: "active" | "blocked" | "suspended";
    newMembershipStatus: "active" | "blocked" | "suspended";
    eventType: string;
  }
> = {
  approve: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventType: "admin.user.approved",
  },
  block: {
    newStatus: "blocked",
    newMembershipStatus: "blocked",
    eventType: "admin.user.blocked",
  },
  suspend: {
    newStatus: "suspended",
    newMembershipStatus: "suspended",
    eventType: "admin.user.suspended",
  },
  reactivate: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventType: "admin.user.reactivated",
  },
};

export const POST = withAdminRoute(async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.manage_status",
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
  const outranked = await refuseOutrankingTarget(guard, target, request, "status");
  if (outranked) return outranked;

  // AUTHZ-1: derive the actor's tenant scope so the mutation core can confine
  // an org admin to their own org. resolveTargetUser already 404s a non-
  // superadmin without a resolvable org, so a null scope here is defensive.
  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return adminErrorResponse("not_found", 404, request, { requestId: guard.requestId });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request, { requestId: guard.requestId });
  }
  const parsed = statusSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request, { requestId: guard.requestId });
  }

  const mapping = ACTION_TO_STATUS[parsed.data.action];
  // F-77: activating an agent service account is the Agents console's approve,
  // which needs `admin.clients.manage`; `admin.users.manage` alone let an admin
  // who may not approve agents activate one here. Block and suspend stay open
  // to them: they only stop an agent.
  if (
    mapping.newStatus === "active" &&
    isAgentServiceAccount(target) &&
    !mayActivateAgents(guard)
  ) {
    return refuseAgentActivation(guard, target, request, parsed.data.action);
  }
  const result = await performAdminStatusChange({
    actorBetterAuthUserId: guard.betterAuthUserId,
    scope,
    request,
    requestId: guard.requestId,
    targetAppUserId: target.appUserId,
    reason: parsed.data.reason,
    ...mapping,
  });

  if (!result.ok) {
    // REVOKE-2 (review #444): `block` / `suspend` move the target's memberships
    // away from `active`, which is how a `superuser` assignment stops counting.
    // The rank guard above exempts a SUPERADMIN actor outright, so without this
    // branch the platform's last superadmin could block themselves here and
    // leave nobody able to administer it — the same unrecoverable state the
    // revocation routes refuse. The core audits the denial.
    if (result.error === "last_superadmin") {
      return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
        requestId: guard.requestId,
      });
    }
    // F-57: the target is soft-deleted; only restore may move it.
    if (result.error === USE_RESTORE_ERROR) {
      return adminErrorResponse(USE_RESTORE_ERROR, USE_RESTORE_STATUS, request, {
        requestId: guard.requestId,
      });
    }
    // F-147: the status committed but the user's sessions were not ended. The
    // core audited it; a retry is safe.
    if (result.error === "auth_revoke_all_failed") {
      return adminErrorResponse("auth_revoke_all_failed", 502, request, {
        requestId: guard.requestId,
        cause: result.cause,
      });
    }
    return adminErrorResponse("not_found", 404, request, { requestId: guard.requestId });
  }
  return NextResponse.json({ ok: true, status: result.status });
});
