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
import { hasCrossOrgReach, isOrgBound } from "@/lib/admin/access-scope.server";
import {
  permissionKeysByActiveOrg,
  permissionKeysHeldInAnyOrg,
} from "@/lib/admin/grantable-permissions.server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { getCurrentSession, getImpersonatorId } from "@/lib/auth-guard";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { logPreAuthRefusal } from "@/lib/observability/pre-auth-refusal.server";
import { isResolvedUserResponse, isUuid, resolveTargetUser } from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/route-handler.server";

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
 *   - The escalation guard compares the actor against the target's authority
 *     in EVERY org the target is an active member of (IMP-1) AND, tenant by
 *     tenant, in every org the two SHARE (IMP-2); the session it hands back is
 *     confined at use time to the impersonator's own reach
 *     (`getUserAccessContext`) — see the long note on the guard below.
 *   - Caller MUST NOT be an ORG-BOUND bearer credential (MACHINE-2): the
 *     returned session is a cookie session and therefore unbound, so this is
 *     the one action that could convert a tenant-confined credential into an
 *     unconfined one. Refused with 403.
 *   - Caller MUST NOT already be impersonating (F-02): a borrowed session is
 *     not the admin, and impersonating FROM it re-bases the tenant
 *     confinement on the borrowed identity's reach instead of the human's.
 *     Refused with 403, audited against the human impersonator.
 *   - The UI MUST present a double-confirm before calling this
 *     endpoint. The server cannot enforce that, but it does cap the
 *     call rate via the shared in-memory token bucket so a missing
 *     confirm cannot turn into a runaway loop.
 *   - Both success AND failure are audited; the actor id is the
 *     ORIGINAL admin (never the impersonated user) so the audit row
 *     attributes the action correctly.
 */
export const POST = withAdminRoute(async function POST(request: NextRequest, ctx: RouteContext) {
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

  // F-02 — NO NESTED IMPERSONATION. The tenant confinement of an impersonated
  // session is the IMPERSONATOR's reach (`listImpersonationReachableOrgIds`,
  // keyed on the session's `impersonatedBy`). Starting a second impersonation
  // from a borrowed session makes Better Auth stamp the BORROWED identity as
  // `impersonatedBy`, so the next session is confined to that identity's reach
  // — which is wider than the human's whenever the borrowed user belongs to a
  // tenant the human does not. Admin A (org P only) impersonates co-admin X
  // (P and Q), then Y from X's session: Y's session admits Q, and A browses a
  // tenant they were never in, with X, not A, in the audit trail.
  //
  // Refused before anything else about the target is examined, so the refusal
  // leaks nothing about it, and audited against the HUMAN behind the session.
  // Stop the current impersonation first; nothing legitimate needs a chain.
  if (guard.impersonatorId) {
    await auditEvent({
      eventType: "admin.user.impersonation_failed",
      outcome: "denied",
      actorBetterAuthUserId: guard.impersonatorId,
      reason: "nested_impersonation",
      request,
      requestId: guard.requestId,
      metadata: {
        impersonatedBetterAuthUserId: guard.betterAuthUserId,
        // The raw path segment is untrusted; only a well-formed id is recorded.
        requestedTargetId: isUuid(id) ? id : null,
      },
    });
    return adminErrorResponse("forbidden_while_impersonating", 403, request, {
      requestId: guard.requestId,
    });
  }

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
  // IMP-1 — this used to evaluate the target in a SINGLE org (the actor's
  // `active_org`), on the premise that an impersonated session is
  // tenant-confined because `/api/preferences/active-org(/apply)` refuse to
  // switch while `impersonatedBy` is set. That premise was FALSE: `active_org`
  // is a plain UNSIGNED cookie read by `getUserAccessContext` for whichever
  // user the session names — during an impersonation, the TARGET — so the
  // admin holding the browser could simply rewrite it (devtools, or curl) and
  // land in a tenant this guard never evaluated. Exactly the shape the old
  // comment warned about: a target who is a plain member locally but an ADMIN
  // in another tenant passed here and was then pivoted into that tenant.
  //
  // So the guard now evaluates the UNION of the target's authority across every
  // org they are an active member of (`permissionKeysHeldInAnyOrg`), and the
  // tenancy hole itself is closed independently in `getUserAccessContext`
  // (IMP-1 confinement: an impersonated session may only resolve an org the
  // IMPERSONATOR could already reach). Both are needed — the union stops the
  // impersonation starting, the confinement stops the pivot afterwards — and
  // neither is a licence to drop the other.
  //
  // IMP-2 — nor are those two enough between them, because they never meet on
  // the same axis: the confinement bounds WHICH tenants, the union bounds rank
  // but only against ONE of the actor's tenants. The per-tenant bound after the
  // union closes that seam; its long note is at the call site below.
  //
  // MACHINE-2: an ORG-BOUND bearer credential may not impersonate AT ALL.
  //
  // Impersonation is the one admin action that converts the caller's authority
  // into a different KIND of credential: it hands back a COOKIE session for the
  // target, and a cookie session is by definition not org-bound
  // (`orgBound: false`, `hasCrossOrgReach` true for a superuser target). A
  // credential confined to one tenant that could exchange itself for such a
  // session would launder itself into exactly the unbounded reach MACHINE-2
  // exists to deny.
  //
  // This is an outright refusal rather than the subset check below, because for
  // the case that matters the subset check is vacuous: `getUserAccessContext`
  // expands a bound SUPERUSER credential to the whole `ADMIN_PERMISSION_CATALOG`
  // (auth-status.ts — correctly; see the comment there), so
  // `targetPermissions.some(p => !actorPermissions.has(p))` is
  // structurally unsatisfiable and every target would pass. Today the exchange
  // is also blocked incidentally — Better Auth's `impersonateUser` resolves the
  // actor from the request's own session cookie, and a pure-bearer request has
  // none — but that is an accident of another package's implementation, and it
  // evaporates the moment a caller presents BOTH a bound credential (which
  // `resolveCaller` prefers) and their own cookie. Do not demote this to the
  // subset check on the strength of that incidental defence.
  //
  // Impersonation is a HUMAN-session capability, like the superadmin bypass in
  // access-scope.server.ts. A machine credential that needs to act as a user
  // should be minted for that user.
  if (isOrgBound(guard.access)) {
    await auditUserAction("admin.user.impersonation_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "org_bound_credential",
      metadata: { targetBetterAuthUserId: target.betterAuthUserId },
    });
    return adminErrorResponse("forbidden", 403, request);
  }

  // The `hasCrossOrgReach` skip below is equivalent to `isSuperadmin` now that
  // every org-bound caller has been refused outright — it is kept in that form
  // so the tenant-boundary predicate stays the one used for every such decision
  // (and so re-introducing a bound caller here cannot silently skip the check).
  if (!hasCrossOrgReach(guard.access)) {
    const targetPermissions = await permissionKeysHeldInAnyOrg(target.appUserId);
    const actorPermissions = new Set(guard.access.permissions);
    const escalates = targetPermissions.some((perm) => !actorPermissions.has(perm));
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

    // IMP-2 — PER-TENANT RANK BOUND. The union test above and the tenant
    // confinement in `getUserAccessContext` were believed to cover each other,
    // but they measure DIFFERENT axes and so never intersect: the confinement
    // caps WHICH orgs the borrowed session may resolve (the impersonator's own)
    // and says nothing about rank inside them, while the union compares the
    // target's cross-org total against the actor's authority in ONE org — the
    // actor's active one. The gap costs an attacker nothing to reach wherever
    // support or partner staff are guest members of several tenants:
    //
    //   actor  — admin of org A (impersonate + users.read + roles.update),
    //            ordinary role-less member of org B
    //   target — plain member of A, ADMIN of B (users.read + roles.update)
    //
    // The union is {users.read, roles.update} ⊆ the actor's org-A set, so the
    // impersonation starts. The confinement then ADMITS org B, because the
    // actor really is a member there. Rewriting the unsigned `active_org`
    // cookie to B lands a session holding `admin.roles.update` in a tenant the
    // actor has no authority in — and from there `POST /api/administrator/
    // api-keys` mints a bearer credential on behalf of an org-B user, which is
    // exactly the durable laundering Layer 2 refuses on the self-service
    // rotate route. The more tenants the impersonator belongs to, the closer
    // the confinement gets to a no-op.
    //
    // So the rule is about AUTHORITY PER ORGANIZATION, not membership: for
    // every org BOTH parties are active members of, the target may hold
    // nothing there the actor does not also hold THERE. Orgs the actor is not
    // a member of are deliberately not judged here — the confinement already
    // makes them unreachable, and the union above is what refuses the one
    // target that would escape both (a global superuser: see
    // `permissionKeysHeldInAnyOrg`).
    //
    // A superadmin actor is skipped along with the union, by the same
    // `hasCrossOrgReach` test above: they already hold every permission in
    // every org, so there is no rank for them to escalate to. That is also why
    // the tenant confinement can safely leave a superadmin impersonator
    // unconfined (src/lib/impersonation-reach.server.ts).
    const actorAppUserId = guard.access.appUserId;
    if (!actorAppUserId) {
      // Fail closed. `requireAdminPermission` only admits an active, provisioned
      // member, so this is unreachable — but the rank bound below is meaningless
      // without an actor to measure, and a null must never read as "no shared
      // tenant, therefore allowed".
      await auditUserAction("admin.user.impersonation_failed", "failure", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
        email: target.primaryEmail,
        reason: "actor_not_provisioned",
        metadata: { targetBetterAuthUserId: target.betterAuthUserId },
      });
      return adminErrorResponse("forbidden", 403, request);
    }

    const [targetByOrg, actorByOrg] = await Promise.all([
      permissionKeysByActiveOrg(target.appUserId),
      permissionKeysByActiveOrg(actorAppUserId),
    ]);
    const outrankedOrgIds = [...targetByOrg]
      .filter(([organizationId, targetKeys]) => {
        const actorKeys = actorByOrg.get(organizationId);
        // Not a SHARED tenant — the confinement, not this bound, is what keeps
        // the borrowed session out of it.
        if (actorKeys === undefined) return false;
        return [...targetKeys].some((perm) => !actorKeys.has(perm));
      })
      .map(([organizationId]) => organizationId);

    if (outrankedOrgIds.length > 0) {
      await auditUserAction("admin.user.impersonation_failed", "failure", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
        email: target.primaryEmail,
        reason: "privilege_escalation_in_shared_org",
        // Only orgs the ACTOR is an active member of can appear here, so this
        // names no tenant they could not already enumerate.
        metadata: {
          targetBetterAuthUserId: target.betterAuthUserId,
          organizationIds: outrankedOrgIds,
        },
      });
      return adminErrorResponse("forbidden", 403, request);
    }
  }

  // F-02, defence in depth. Better Auth's `impersonateUser` acts on the
  // request's SESSION COOKIE, not on the caller the guards above evaluated.
  // Every rule in this handler is only sound if the two are the same
  // principal, so re-read the cookie Better Auth will act on and require it to
  // BE that principal, on an ordinary (not borrowed) session. Fails closed: no
  // cookie session, a different user, or a borrowed session all refuse.
  const liveSession = await getCurrentSession();
  const liveImpersonatorId = getImpersonatorId(liveSession);
  if (liveImpersonatorId || liveSession?.user.id !== guard.betterAuthUserId) {
    await auditEvent({
      eventType: "admin.user.impersonation_failed",
      outcome: "denied",
      actorBetterAuthUserId: liveImpersonatorId ?? guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: liveImpersonatorId ? "nested_impersonation" : "session_principal_mismatch",
      request,
      requestId: guard.requestId,
      metadata: { targetBetterAuthUserId: target.betterAuthUserId },
    });
    return liveImpersonatorId
      ? adminErrorResponse("forbidden_while_impersonating", 403, request, {
          requestId: guard.requestId,
        })
      : adminErrorResponse("forbidden", 403, request, {
          requestId: guard.requestId,
          extra: { reason: "session_principal_mismatch" },
        });
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
});

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
export const DELETE = withAdminRoute(async function DELETE(request: NextRequest) {
  const requestId = getOrCreateRequestId(request);

  // §4 Origin/Referer defence on this cookie-authed mutation (the admin guard
  // does this for permission-gated routes; replicated here since we bypass it).
  // Refused before the session is read: logged + counted, not audited (F-15).
  const origin = checkTrustedOrigin(request);
  if (!origin.ok) {
    logPreAuthRefusal({
      eventType: "administrator.access.denied",
      outcome: "denied",
      reason: origin.reason ?? "untrusted_origin",
      request,
      requestId,
      metadata: { action: "impersonation_stop" },
    });
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
});
