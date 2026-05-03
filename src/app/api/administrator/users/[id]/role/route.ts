import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { setBetterAuthUserRole } from "@/lib/admin/auth-admin.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
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
 * POST /api/administrator/users/[id]/role
 *
 * Sets the Better Auth role for a user (`user` or `admin`). This is
 * distinct from app roles managed via `app_user_roles` — see plan §4
 * row "admin.setRole" and §6.1 for the separation of concerns.
 *
 * Caller MUST hold `admin.users.setRole`.
 */
const roleSchema = z
  .object({
    role: z.enum(["admin", "user"]),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.setRole");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit("admin.users.role", guard.betterAuthUserId, DEFAULT_ADMIN_MUTATION_LIMIT);
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = roleSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  try {
    await setBetterAuthUserRole(
      { userId: target.betterAuthUserId, role: parsed.data.role },
      request,
    );
  } catch (err) {
    await auditUserAction("admin.user.set_role_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_set_role_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_set_role_failed", 502, request);
  }

  await auditUserAction("admin.user.role_set", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    reason: parsed.data.reason ?? null,
    metadata: { role: parsed.data.role },
  });

  return NextResponse.json({ ok: true, role: parsed.data.role });
}
