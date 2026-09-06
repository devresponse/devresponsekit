import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  listBetterAuthUserSessions,
  revokeBetterAuthUserSession,
} from "@/lib/admin/auth-admin.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { findSessionToken } from "@/lib/admin/session-item";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; sessionId: string }> };

/**
 * DELETE /api/administrator/users/[id]/sessions/[sessionId]
 *
 * Revokes one specific Better Auth session for the target user. The
 * `sessionId` is the session's `id` as returned by `GET …/sessions`
 * (`SessionItem.id`) — NOT the session token. Better Auth's revoke API only
 * understands tokens, so the handler resolves the id to its token
 * server-side, scoped to the TARGET user's own sessions (review #67/#194):
 * the token never crosses the wire in either direction, and an id that is
 * not one of this user's sessions is a 404 (no cross-user revocation, no
 * probing by id). Caller MUST hold `admin.users.sessions`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.sessions");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.session_revoke",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id, sessionId } = await ctx.params;
  if (!sessionId || sessionId.length < 1 || sessionId.length > 256) {
    return adminErrorResponse("invalid_session_id", 400, request);
  }
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  // Privilege ordering (review #7): a non-SUPERADMIN may not act on a target
  // who outranks them (a superadmin, or a more-privileged peer) — 403 + audit.
  const outranked = await refuseOutrankingTarget(guard, target, request, "session_revoke");
  if (outranked) return outranked;

  let sessionToken: string | null;
  try {
    const sessions = await listBetterAuthUserSessions(target.betterAuthUserId, request);
    sessionToken = findSessionToken(sessions, sessionId);
  } catch (err) {
    await auditUserAction("admin.user.session_revoke_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_list_sessions_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", sessionId },
    });
    return adminErrorResponse("auth_list_sessions_failed", 502, request, { cause: err });
  }
  if (sessionToken === null) {
    return adminErrorResponse("session_not_found", 404, request);
  }

  try {
    await revokeBetterAuthUserSession(sessionToken, request);
  } catch (err) {
    await auditUserAction("admin.user.session_revoke_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_revoke_session_failed",
      // The session id is an opaque identifier, safe to record; the token
      // resolved above is a credential and is NEVER written to metadata.
      metadata: { message: err instanceof Error ? err.message : "unknown", sessionId },
    });
    return adminErrorResponse("auth_revoke_session_failed", 502, request, { cause: err });
  }

  await auditUserAction("admin.user.session_revoked", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    metadata: { sessionId },
  });

  return NextResponse.json({ ok: true });
}
