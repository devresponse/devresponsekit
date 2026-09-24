import "server-only";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  actingOrganizationId,
  canAccessUser,
  hasCrossOrgReach,
  isSuperadmin,
  userHoldsSuperuserGrant,
  type AccessLike,
} from "@/lib/admin/access-scope.server";
import { getUserAccessContext } from "@/lib/auth-status";

/**
 * Shared helpers for the `/api/administrator/users/[id]/*` routes.
 *
 * Centralizes the "look up the target user by id, return 404 if
 * missing" pattern so each per-action endpoint stays declarative and
 * the 404 response shape is uniform.
 */
export interface ResolvedTargetUser {
  appUserId: string;
  betterAuthUserId: string;
  primaryEmail: string;
  displayName: string | null;
  status: string;
}

/**
 * RFC 4122-shaped UUID regex. Exported so RSC pages and other helpers
 * (`page.tsx` for the user detail route, etc.) share a single source
 * of truth — duplicating this in multiple places would risk subtle
 * drift if we ever needed to widen / tighten the pattern.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Resolve the target `app_users` row by primary key. Returns either the
 * resolved row or a ready-to-return `NextResponse` for 404 / 400.
 *
 * - `id` validation accepts only UUIDs to avoid pivoting to other
 *   columns or surfacing 500s from the DB layer when callers pass raw
 *   strings.
 * - The optional `request` argument lets the produced error envelopes
 *   carry the standard `{message, requestId}` fields and the matching
 *   `x-request-id` header (docs/admin-manager.md §5.1, §12). All admin
 *   route handlers pass it; tests and legacy callers may omit it, in
 *   which case a fresh request id is minted for the error envelope.
 */
export async function resolveTargetUser(
  id: string,
  access: AccessLike,
  request?: { headers: Headers },
): Promise<ResolvedTargetUser | NextResponse> {
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }
  const row = await db
    .selectFrom("app_users")
    .select(["id", "better_auth_user_id", "primary_email", "display_name", "status"])
    .where("id", "=", id)
    .executeTakeFirst();
  // ADR-0001: an org admin may only target users in their own org. A 404
  // (not 403) on an out-of-scope user avoids leaking its existence — the
  // `access` argument is REQUIRED so no caller can forget to scope.
  // MACHINE-2: `canAccessUser` also caps an ORG-BOUND credential to its bound
  // org, so a superuser-owned key cannot pivot to another tenant's users via
  // any `/administrator/users/[id]/*` action.
  if (!row || !(await canAccessUser(access, row.id))) {
    return adminErrorResponse("not_found", 404, request);
  }
  return {
    appUserId: row.id,
    betterAuthUserId: row.better_auth_user_id,
    primaryEmail: row.primary_email,
    displayName: row.display_name,
    status: row.status,
  };
}

export function isResolvedUserResponse(
  value: ResolvedTargetUser | NextResponse,
): value is NextResponse {
  return value instanceof NextResponse;
}

type ActorAccess = AccessLike;

/**
 * Privilege-ordering guard for account-level actions on ANOTHER user
 * (review #7). Being in scope (`canAccessUser`) and not shared across tenants
 * (`requiresSuperadminForSharedTarget`) says nothing about *rank*: a
 * single-org SUPERADMIN passes both, so without this check an org admin
 * holding `admin.users.setPassword` / `.ban` / `.delete` / `.sessions` /
 * `.manage` could set that superadmin's password (and sign in with global
 * authority), ban them, soft-delete them, revoke their sessions, or change
 * their status.
 *
 * Rule — the same subset test the impersonate route applies:
 *   - a SUPERADMIN actor is exempt (they already hold every power);
 *   - otherwise the target OUTRANKS the actor when the target's effective
 *     permissions **in the actor's org** include any permission the actor
 *     lacks. That covers a target holding `superuser` (expanded to the full
 *     superuser set by `getUserAccessContext`, and folded in globally via
 *     `userIsGlobalSuperuser`, so an out-of-org superadmin is caught too) and
 *     a more-privileged peer.
 *
 * The target is evaluated in the actor's org via the bound-org path of
 * `getUserAccessContext` so the result never depends on the request's
 * `active_org` cookie. A non-superadmin actor with no resolvable org fails
 * closed (`true`) — `resolveTargetUser` has already 404'd that case, so this
 * is defensive only.
 *
 * MACHINE-2 — an ORG-BOUND credential may never act on a GLOBAL SUPERUSER
 * target, whatever its own permission set says. This rule has to be stated in
 * terms of RANK rather than left to the subset comparison below, because for a
 * bound superuser credential that comparison is vacuous: `getUserAccessContext`
 * expands such a principal to `SUPERUSER_PERMISSIONS` — `shell.view` +
 * `audit.view` + `superuser` + the WHOLE `ADMIN_PERMISSION_CATALOG` — so the
 * actor's set is a superset of every target's and `escalates` can never be
 * true. The `isSuperadmin` exemption on the next line short-circuits it to
 * `false` even earlier. Either way, without this line an org-bound credential
 * could set the password of, ban, soft-delete or revoke the sessions of a
 * platform superuser who happens to be a member of its bound org — and a
 * password reset is a direct route to that superuser's COOKIE session, which
 * carries the unbounded reach MACHINE-2 exists to deny.
 *
 * The check is deliberately ADDITIVE — it only ever adds a refusal. An
 * org-bound NON-superuser credential still falls through to the subset test,
 * which is the stricter rule for it (a more-privileged peer who is not a global
 * superuser must still outrank it).
 *
 * F-09 — THE SAME RANK CHECK NOW RUNS FOR EVERY NON-SUPERADMIN ACTOR, and it
 * reads {@link userHoldsSuperuserGrant} (a grant through an active membership,
 * whatever the ORGANIZATION'S status) rather than `userIsGlobalSuperuser`.
 * Organization status now gates superuser AUTHORITY: a grant held in a
 * suspended tenant confers nothing, so the target's context in the actor's org
 * is no longer expanded and the subset test below stops seeing it. The grant
 * is only asleep, though. It wakes when the tenant is reactivated, so a
 * delegated admin who shares another active tenant with that superuser could
 * otherwise set their password today and sign in as a platform superadmin
 * tomorrow. For a target whose grant is awake the line changes nothing, since
 * the expanded subset test already refused them. It costs every non-superadmin
 * actor one indexed lookup; a superadmin at a browser still skips it. The
 * sibling mint-time bound (`ownerOutranksActor`, on the four on-behalf
 * credential paths) reads the same predicate for the same reason.
 *
 * The `isSuperadmin` exemption itself stays unnarrowed for the ordinary case:
 * the target set was already produced by `resolveTargetUser` → `canAccessUser`,
 * which caps an org-bound credential to its bound org, so the comparison is
 * always between two principals inside ONE tenant — and inside its bound tenant
 * an org-bound superuser genuinely IS a superadmin over non-superuser members.
 *
 * Self-service surfaces (`/api/account/*`) never call this: it is for the
 * administrator routes acting on a *different* user.
 */
export async function targetOutranksActor(
  access: ActorAccess,
  target: Pick<ResolvedTargetUser, "betterAuthUserId" | "appUserId">,
): Promise<boolean> {
  // A superadmin at a browser outranks everyone (they hold every power
  // already) and skips every lookup.
  if (hasCrossOrgReach(access)) return false;
  // MACHINE-2 (org-bound credentials) and F-09 (dormant grants): nobody else
  // may act on a principal holding a superuser grant, awake or asleep.
  if (await userHoldsSuperuserGrant(target.appUserId)) return true;
  if (isSuperadmin(access)) return false;
  if (!access.organizationId) return true;
  const targetAccess = await getUserAccessContext(target.betterAuthUserId, {
    organizationId: access.organizationId,
  });
  const actorPermissions = new Set(access.permissions);
  return targetAccess.permissions.some((perm) => !actorPermissions.has(perm));
}

/**
 * Audit event written when {@link targetOutranksActor} refuses an action.
 * One event type (with `reason: "target_outranks_actor"` and the attempted
 * `action` in metadata) so the audit explorer can list every refused
 * privilege-ordering attempt with a single filter.
 */
export const TARGET_OUTRANKS_ACTOR_EVENT = "admin.user.action_denied";
export const TARGET_OUTRANKS_ACTOR_REASON = "target_outranks_actor";

/**
 * Route-level wrapper around {@link targetOutranksActor}: when the target
 * outranks the actor, audits `admin.user.action_denied` (`denied`) and returns
 * the standard **403** `forbidden` envelope — the same shape the impersonate
 * route's escalation guard produces. Returns `null` when the action may
 * proceed. Call it immediately after `resolveTargetUser` (before any body
 * parsing or Better Auth / DB side effect) in every `[id]` route that mutates
 * or inspects another user's account.
 */
export async function refuseOutrankingTarget(
  guard: { access: ActorAccess; betterAuthUserId: string; requestId?: string },
  target: ResolvedTargetUser,
  request: { headers: Headers },
  action: string,
): Promise<NextResponse | null> {
  if (!(await targetOutranksActor(guard.access, target))) return null;
  await auditUserAction(TARGET_OUTRANKS_ACTOR_EVENT, "denied", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: actingOrganizationId(guard.access),
    email: target.primaryEmail,
    requestId: guard.requestId ?? null,
    reason: TARGET_OUTRANKS_ACTOR_REASON,
    metadata: { action, targetBetterAuthUserId: target.betterAuthUserId },
  });
  return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
}
