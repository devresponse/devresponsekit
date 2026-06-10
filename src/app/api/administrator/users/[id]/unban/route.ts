import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { unbanBetterAuthUser } from "@/lib/admin/auth-admin.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/unban
 *
 * Inverse of {@link ./../ban}. No body required. Caller MUST hold
 * `admin.users.ban`.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.ban");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.unban",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id);
  if (isResolvedUserResponse(target)) return target;

  try {
    await unbanBetterAuthUser(target.betterAuthUserId, request);
  } catch (err) {
    await auditUserAction("admin.user.unban_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_unban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_unban_failed", 502, request);
  }

  await auditUserAction("admin.user.unbanned", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
  });

  return NextResponse.json({ ok: true });
}
