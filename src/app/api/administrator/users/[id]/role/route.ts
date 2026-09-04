import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { setBetterAuthUserRole } from "@/lib/admin/auth-admin.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

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

  // Granting the Better Auth platform role (`admin`) is SUPERADMIN-only.
  // The raw `/api/auth/admin/*` plugin surface is closed (404 over HTTP —
  // see src/lib/auth-admin-surface.ts), but the role is still what the
  // plugin's own authz requires for every `auth.api.*` admin call the
  // console routes make on the actor's behalf (list/ban/impersonate/
  // set-password), i.e. it is the key to the whole admin console. Holding
  // `admin.users.setRole` alone must therefore NOT let an org admin mint a
  // platform admin (cross-tenant privilege escalation).
  // Org-level role management goes through `app_user_roles` / app-roles.
  if (!isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const limited = enforceRateLimit(
    "admin.users.role",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
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
    return adminErrorResponse("auth_set_role_failed", 502, request, { cause: err });
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
