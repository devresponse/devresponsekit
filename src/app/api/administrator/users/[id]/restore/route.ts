import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { unbanBetterAuthUser } from "@/lib/admin/auth-admin.server";
import {
  isAdminPermissionDenial,
  requireAdminPermission,
} from "@/lib/admin/permissions.server";
import {
  DEFAULT_ADMIN_MUTATION_LIMIT,
  enforceRateLimit,
} from "@/lib/admin/rate-limit.server";
import {
  isResolvedUserResponse,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/restore
 *
 * Inverse of the soft-delete (plan §4.1):
 *   1. Unban the Better Auth user.
 *   2. Set `app_users.status` back to `pending_approval` and clear the
 *      `deactivated_*` columns. We deliberately do NOT auto-restore to
 *      `active` — an admin should re-approve via the status endpoint so
 *      the approval intent is captured in audit.
 *
 * Caller MUST hold `admin.users.delete` (same permission gates both
 * directions of the soft-delete lifecycle, per plan §4.1).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit("admin.users.restore", guard.betterAuthUserId, DEFAULT_ADMIN_MUTATION_LIMIT);
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id);
  if (isResolvedUserResponse(target)) return target;

  if (target.status !== "deactivated") {
    return NextResponse.json({ error: "not_deactivated" }, { status: 409 });
  }

  try {
    await unbanBetterAuthUser(target.betterAuthUserId, request);
  } catch (err) {
    await auditUserAction("admin.user.restore_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_unban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return NextResponse.json({ error: "auth_unban_failed" }, { status: 502 });
  }

  await db
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

  await auditUserAction("admin.user.restored", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
  });

  return NextResponse.json({ ok: true, status: "pending_approval" });
}
