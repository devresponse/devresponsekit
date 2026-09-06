import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  listBetterAuthUserSessions,
  revokeAllBetterAuthUserSessions,
} from "@/lib/admin/auth-admin.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
} from "@/lib/admin/access-scope.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";
import { normalizeSessionList, toSessionItem } from "@/lib/admin/session-item";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/users/[id]/sessions
 *
 * Returns the active Better Auth sessions for the target user
 * (docs/admin-manager.md §8.1), PROJECTED to `SessionItem` (id + timestamps +
 * ip/user-agent + impersonatedBy). The raw rows carry `token` — the session's
 * bearer credential — which must never leave the server (review #67/#194);
 * clients revoke by `id`. Pagination is not exposed here — Better Auth's
 * session list is naturally bounded by `expiresIn` (8h rolling) and the
 * number of concurrent devices a single user can be signed in on.
 *
 * Caller MUST hold `admin.users.sessions`.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.sessions");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  // Privilege ordering (review #7): a non-SUPERADMIN may not act on a target
  // who outranks them (a superadmin, or a more-privileged peer) — 403 + audit.
  const outranked = await refuseOutrankingTarget(guard, target, request, "sessions_list");
  if (outranked) return outranked;

  let sessions: unknown;
  try {
    sessions = await listBetterAuthUserSessions(target.betterAuthUserId, request);
  } catch (err) {
    await auditUserAction("admin.user.sessions_list_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_list_sessions_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_list_sessions_failed", 502, request, { cause: err });
  }

  // Better Auth returns `{ sessions: [...] }` or a bare array depending on
  // plugin version; normalize, then project each row to the allow-listed
  // `SessionItem` shape (drops `token`, review #67/#194).
  return NextResponse.json({ sessions: normalizeSessionList(sessions).map(toSessionItem) });
}

/**
 * DELETE /api/administrator/users/[id]/sessions
 *
 * Force sign-out everywhere — revokes all Better Auth sessions for the
 * target user. Caller MUST hold `admin.users.sessions`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.sessions");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.sessions",
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
  const outranked = await refuseOutrankingTarget(guard, target, request, "sessions_revoke_all");
  if (outranked) return outranked;

  // AUTHZ-2: force sign-out everywhere is account-global — it ends the user's
  // sessions in EVERY org. For a user shared across tenants that's
  // SUPERADMIN-only; an org admin may only revoke sessions of a user confined
  // to their own org.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return adminErrorResponse("not_found", 404, request);
  if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  try {
    await revokeAllBetterAuthUserSessions(target.betterAuthUserId, request);
  } catch (err) {
    await auditUserAction("admin.user.sessions_revoke_all_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_revoke_all_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_revoke_all_failed", 502, request, { cause: err });
  }

  await auditUserAction("admin.user.sessions_revoked_all", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
  });

  return NextResponse.json({ ok: true });
}
