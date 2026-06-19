import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { revokeBetterAuthUserSession } from "@/lib/admin/auth-admin.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; sessionId: string }> };

/**
 * DELETE /api/administrator/users/[id]/sessions/[sessionId]
 *
 * Revokes one specific Better Auth session for the target user. The
 * `sessionId` here is the Better Auth session token. Caller MUST hold
 * `admin.users.sessions`.
 *
 * The user `id` parameter exists for URL clarity and audit grouping;
 * Better Auth's revoke API only requires the session token. We still
 * validate the user resolves so callers cannot probe by guessing only
 * a session token.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.sessions");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.session_revoke",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id, sessionId } = await ctx.params;
  if (!sessionId || sessionId.length < 1 || sessionId.length > 256) {
    return adminErrorResponse("invalid_session_id", 400, request);
  }
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  try {
    await revokeBetterAuthUserSession(sessionId, request);
  } catch (err) {
    await auditUserAction("admin.user.session_revoke_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_revoke_session_failed",
      // Do NOT log the raw session token in metadata — fingerprint
      // length only so ops can debug shape issues without leaking it.
      metadata: {
        message: err instanceof Error ? err.message : "unknown",
        sessionTokenLength: sessionId.length,
      },
    });
    return adminErrorResponse("auth_revoke_session_failed", 502, request, { cause: err });
  }

  await auditUserAction("admin.user.session_revoked", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    metadata: { sessionTokenLength: sessionId.length },
  });

  return NextResponse.json({ ok: true });
}
