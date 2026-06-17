import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { performAdminStatusChange } from "@/lib/admin-status.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/status
 *
 * Applies one of the status transitions (`approve` | `block` |
 * `suspend` | `reactivate`) to the target user via the shared
 * `performAdminStatusChange` core (plan §4 + §5.2), which also backs
 * the bulk endpoint so both paths emit identical audit events.
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

export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.manage_status",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

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
    return adminErrorResponse("not_found", 404, request, { requestId: guard.requestId });
  }
  return NextResponse.json({ ok: true, status: result.status });
}
