import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  impersonateBetterAuthUser,
  stopBetterAuthImpersonating,
} from "@/lib/admin/auth-admin.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/impersonate
 *
 * Starts a Better Auth impersonation session as the target user and
 * audits the action (docs/admin-manager.md §19 Phase 7). Forwarded
 * `Set-Cookie` headers from Better Auth must reach the browser so the
 * caller's next request hits the impersonated session — we therefore
 * synthesize the response from Better Auth's headers rather than from
 * a bare JSON body.
 *
 * Threat / contract:
 *   - Caller MUST hold `admin.users.impersonate`.
 *   - Caller MUST NOT impersonate themselves; we reject with 400 to
 *     avoid an audit trail of meaningless self-impersonation events.
 *   - The UI MUST present a double-confirm before calling this
 *     endpoint. The server cannot enforce that, but it does cap the
 *     call rate via the shared in-memory token bucket so a missing
 *     confirm cannot turn into a runaway loop.
 *   - Both success AND failure are audited; the actor id is the
 *     ORIGINAL admin (never the impersonated user) so the audit row
 *     attributes the action correctly.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.impersonate");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.impersonate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  if (target.betterAuthUserId === guard.betterAuthUserId) {
    return adminErrorResponse("cannot_impersonate_self", 400, request);
  }

  let result: unknown;
  try {
    result = await impersonateBetterAuthUser(target.betterAuthUserId, request);
  } catch (err) {
    await auditUserAction("admin.user.impersonation_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_impersonate_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_impersonate_failed", 502, request);
  }

  await auditUserAction("admin.user.impersonation_started", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    metadata: {
      targetBetterAuthUserId: target.betterAuthUserId,
    },
  });

  // Forward any Set-Cookie headers Better Auth may have attached to
  // the underlying response so the caller's browser actually adopts
  // the new impersonated session. Better Auth's plugin shape varies
  // between versions — we defensively check both `headers` and a bare
  // result object.
  const response = NextResponse.json({ ok: true });
  const upstreamHeaders = (result as { headers?: Headers } | null | undefined)?.headers;
  if (upstreamHeaders instanceof Headers) {
    for (const [name, value] of upstreamHeaders.entries()) {
      if (name.toLowerCase() === "set-cookie") {
        response.headers.append("set-cookie", value);
      }
    }
  }
  return response;
}

/**
 * DELETE /api/administrator/users/[id]/impersonate
 *
 * Ends the active impersonation session and restores the original
 * actor's cookies. The `[id]` is accepted for symmetry with the start
 * endpoint and used as the audit target; Better Auth itself derives
 * the impersonated user from the active cookie.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.impersonate");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.impersonate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  let result: unknown;
  try {
    result = await stopBetterAuthImpersonating(request);
  } catch (err) {
    await auditUserAction("admin.user.impersonation_stop_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_stop_impersonate_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_stop_impersonate_failed", 502, request);
  }

  await auditUserAction("admin.user.impersonation_stopped", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
  });

  const response = NextResponse.json({ ok: true });
  const upstreamHeaders = (result as { headers?: Headers } | null | undefined)?.headers;
  if (upstreamHeaders instanceof Headers) {
    for (const [name, value] of upstreamHeaders.entries()) {
      if (name.toLowerCase() === "set-cookie") {
        response.headers.append("set-cookie", value);
      }
    }
  }
  return response;
}
