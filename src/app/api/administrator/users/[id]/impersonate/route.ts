import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  impersonateBetterAuthUser,
  stopBetterAuthImpersonating,
} from "@/lib/admin/auth-admin.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { getUserAccessContext } from "@/lib/auth-status";
import { getCurrentSession, getImpersonatorId } from "@/lib/auth-guard";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/users/[id]/impersonate
 *
 * Starts a Better Auth impersonation session as the target user and
 * audits the action (docs/admin-manager.md §19 Phase 7). The impersonated
 * session cookies are delivered by Better Auth's `nextCookies` plugin (it
 * sets them via Next's `cookies()` during `api.impersonateUser`), so the
 * handler returns a plain JSON body.
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
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  if (target.betterAuthUserId === guard.betterAuthUserId) {
    return adminErrorResponse("cannot_impersonate_self", 400, request);
  }

  // Privilege-escalation guard: impersonation grants the actor the target's
  // session. A non-superadmin actor must NOT borrow a session that carries
  // any permission they don't already hold (e.g. an org admin assuming a
  // SUPERADMIN, or a more-privileged peer). SUPERADMIN already holds every
  // power, so the subset check is moot for them and is skipped.
  //
  // This evaluates the target in a SINGLE org (the actor's active_org). That is
  // sound only because an impersonated session is tenant-confined: POST/GET
  // `/api/preferences/active-org(/apply)` refuse to change active_org while
  // `impersonatedBy` is set, so the impersonated session can only ever act in
  // the org checked here. Without that confinement a target who is a plain
  // member locally but an admin in another tenant could be impersonated and
  // then switched into that tenant (P0-1) — do not relax the pin without also
  // widening this guard to the union of the target's memberships.
  if (!isSuperadmin(guard.access)) {
    const targetAccess = await getUserAccessContext(target.betterAuthUserId);
    const actorPermissions = new Set(guard.access.permissions);
    const escalates = targetAccess.permissions.some((perm) => !actorPermissions.has(perm));
    if (escalates) {
      await auditUserAction("admin.user.impersonation_failed", "failure", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
        email: target.primaryEmail,
        reason: "privilege_escalation",
        metadata: { targetBetterAuthUserId: target.betterAuthUserId },
      });
      return adminErrorResponse("forbidden", 403, request);
    }
  }

  try {
    await impersonateBetterAuthUser(target.betterAuthUserId, request);
  } catch (err) {
    await auditUserAction("admin.user.impersonation_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_impersonate_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_impersonate_failed", 502, request, { cause: err });
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

  // The impersonated-session cookies are set by Better Auth's nextCookies
  // plugin during the call above (see src/lib/auth.ts), so a plain JSON body
  // is sufficient.
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/administrator/users/[id]/impersonate
 *
 * Ends the active impersonation session and restores the original actor's
 * cookies.
 *
 * Authorization is DELIBERATELY not `requireAdminPermission(...)`: while
 * impersonating, the live session IS the target user — usually a plain member
 * with NO admin permissions. Gating "stop" on the impersonated identity's
 * permissions would 403 the admin and strand them in the impersonated view
 * with no way back (the bug this fixes). Instead the authority to stop derives
 * from the session BEING an impersonation session: Better Auth set
 * `impersonatedBy` to the original admin at START — which DID pass the
 * permission + privilege-escalation checks — and `stopImpersonating` only
 * restores that admin's own session, so there is no escalation. (Stop must
 * also keep working even if the admin's impersonate permission was revoked
 * mid-session — they must always be able to return to their own account.)
 *
 * We still apply the Origin/CSRF guard + rate limit and audit with the ORIGINAL
 * actor. The `[id]` segment is ignored — the impersonated identity (and the
 * audit target) come from the live session, not the URL.
 */
export async function DELETE(request: NextRequest) {
  const requestId = getOrCreateRequestId(request);

  // §4 Origin/Referer defence on this cookie-authed mutation (the admin guard
  // does this for permission-gated routes; replicated here since we bypass it).
  const origin = checkTrustedOrigin(request);
  if (!origin.ok) {
    return adminErrorResponse("untrusted_origin", 403, request, { requestId });
  }

  const session = await getCurrentSession();
  if (!session) {
    return adminErrorResponse("unauthenticated", 401, request, { requestId });
  }
  const impersonatorId = getImpersonatorId(session);
  if (!impersonatorId) {
    // A real session, but not an impersonation one — nothing to stop.
    return adminErrorResponse("not_impersonating", 400, request, { requestId });
  }

  // Rate-limit keyed on the original actor (the admin who started it).
  const limited = enforceRateLimit(
    "admin.users.impersonate",
    impersonatorId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    requestId,
  );
  if (limited) return limited;

  // Best-effort: resolve the impersonated user's app row for audit attribution.
  const impersonatedBetterAuthId = (session as unknown as { user: { id: string } }).user.id;
  const targetRow = await db
    .selectFrom("app_users")
    .select(["id", "primary_email"])
    .where("better_auth_user_id", "=", impersonatedBetterAuthId)
    .executeTakeFirst();

  // `auditEvent` directly (not `auditUserAction`) because the impersonated
  // user's app row is best-effort here — stop must succeed even if it's
  // missing, so `appUserId` is nullable; the original actor is the audited one.
  try {
    await stopBetterAuthImpersonating(request);
  } catch (err) {
    await auditEvent({
      eventType: "admin.user.impersonation_stop_failed",
      outcome: "failure",
      actorBetterAuthUserId: impersonatorId,
      appUserId: targetRow?.id ?? null,
      email: targetRow?.primary_email ?? null,
      reason: "auth_stop_impersonate_failed",
      request,
      requestId,
      metadata: {
        impersonatedBetterAuthUserId: impersonatedBetterAuthId,
        message: err instanceof Error ? err.message : "unknown",
      },
    });
    return adminErrorResponse("auth_stop_impersonate_failed", 502, request, {
      cause: err,
      requestId,
    });
  }

  await auditEvent({
    eventType: "admin.user.impersonation_stopped",
    outcome: "success",
    actorBetterAuthUserId: impersonatorId,
    appUserId: targetRow?.id ?? null,
    email: targetRow?.primary_email ?? null,
    request,
    requestId,
    metadata: { impersonatedBetterAuthUserId: impersonatedBetterAuthId },
  });

  // As with the start endpoint, the restored actor cookies are delivered by
  // Better Auth's nextCookies plugin during the call above.
  return NextResponse.json({ ok: true });
}
