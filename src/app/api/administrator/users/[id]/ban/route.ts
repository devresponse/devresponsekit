import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
} from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { banBetterAuthUser } from "@/lib/admin/auth-admin.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/ban
 *
 * Wraps `auth.api.banUser`. Reason is required (UX: ban without
 * justification is the kind of action ops will want to look up later);
 * `expiresInSeconds` is optional — omit for indefinite per Better Auth
 * semantics. The new password / token is never logged. The reason is
 * persisted in the audit row's `reason` column (plan §5.2).
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

export async function POST(request: NextRequest, ctx: RouteContext) {
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

  // AUTHZ-2: a Better Auth ban locks the account out of EVERY org. A non-
  // SUPERADMIN may not ban a user shared with other orgs (it would lock them
  // out of tenants the actor does not administer); that is SUPERADMIN-only.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return adminErrorResponse("not_found", 404, request);
  if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
    return adminErrorResponse("forbidden", 403, request);
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

  try {
    await banBetterAuthUser(
      {
        userId: target.betterAuthUserId,
        banReason: parsed.data.reason,
        banExpiresIn: parsed.data.expiresInSeconds,
      },
      request,
    );
  } catch (err) {
    await auditUserAction("admin.user.ban_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_ban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_ban_failed", 502, request, { cause: err });
  }

  await auditUserAction("admin.user.banned", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    reason: parsed.data.reason,
    metadata: { expiresInSeconds: parsed.data.expiresInSeconds ?? null },
  });

  return NextResponse.json({ ok: true });
}
