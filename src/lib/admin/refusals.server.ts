import "server-only";
import type { NextResponse } from "next/server";
import { actingOrganizationId, type AccessLike } from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { auditEvent } from "@/lib/audit.server";

/**
 * F-58 — AN AUTHORIZATION REFUSAL WRITES A `denied` ROW.
 *
 * docs/admin-manager.md §12 makes an audit row mandatory for denied access, and
 * the permission pipeline and the rank guard (`refuseOutrankingTarget`) write
 * one. The privilege guards that run INSIDE a handler did not: an org admin
 * who tried to add themselves to a group conferring `superuser`, to attach a
 * role carrying permissions they lack, to ban or reset a user shared with
 * another tenant, or to mint a Better Auth platform admin got a 403 and left
 * nothing in `app_audit_events`, so the explorer's `denied` filter missed the
 * most direct escalation signal the platform has.
 *
 * Each helper below writes the row and returns the handler's unchanged 403
 * `forbidden` envelope, so a call site swaps `return adminErrorResponse(...)`
 * for `return refuseX(...)` and nothing else. The guard predicate itself stays
 * inline in the handler, where the F-11 and F-61 source scans look for it
 * (`unheldPermissionKeys`, `requiresSuperadminForSharedTarget`,
 * `hasCrossOrgReach`). tests/security/authenticated-refusals-audited.test.ts
 * fails CI when a handler under `src/app/api/administrator` builds a 403 with
 * no `denied` row written beside it.
 *
 * Every row is written with the route's `request`, so an impersonated session's
 * refusal names the human behind it (F-07, `auditEvent`), and with
 * `guard.requestId`, so it joins the response's `x-request-id`.
 */

/** The slice of the permission grant (`requireAdminPermission`) a refusal records. */
export interface RefusingGuard {
  access: AccessLike;
  betterAuthUserId: string;
  requestId?: string;
}

/**
 * AUTHZ-3 and REVOKE-1: one event type for every grant or revocation refused
 * because the actor could not confer what it carries, whichever route it came
 * through, so the explorer lists them with one filter. `metadata.action` names
 * the route's operation and `metadata.unheldPermissions` the keys refused. The
 * two refusals that predate it keep their own names: `admin.group.delete_denied`
 * (F-11) and `admin.membership.revocation_denied` (F-12).
 */
export const CONFERRAL_DENIED_EVENT = "admin.permission.conferral_denied";
export const UNHELD_PERMISSIONS_REASON = "unheld_permissions";

/**
 * AUTHZ-2: written under the rank guard's event (`TARGET_OUTRANKS_ACTOR_EVENT`
 * in user-target.server.ts), so one filter lists every action on a user that
 * was refused, whichever rule refused it; `reason` tells them apart.
 */
export const USER_ACTION_DENIED_EVENT = "admin.user.action_denied";
export const SHARED_TARGET_REASON = "shared_target_requires_superadmin";

/**
 * A superadmin-only action refused to a caller without cross-org reach: the
 * pipeline's own event, since it is the same question one step later (this
 * caller's authority does not reach the action), with the reason the provider
 * binding refusal (F-04) already uses.
 */
export const ACCESS_DENIED_EVENT = "administrator.access.denied";
export const CROSS_ORG_REACH_REQUIRED_REASON = "cross_org_reach_required";

/**
 * F-15: a refusal row lands in an append-only table on a request an
 * authenticated caller composed, and a body may name up to 500 ids. So a row
 * records a list the request named as its first `REFUSAL_LIST_MAX` distinct
 * entries beside the distinct count ({@link boundedRequestList}): the usual
 * one-user request is recorded whole, and a 500-id one cannot park kilobytes.
 */
export const REFUSAL_LIST_MAX = 20;

/** A request-named list as a refusal row records it (see `REFUSAL_LIST_MAX`). */
export function boundedRequestList(values: ReadonlyArray<string>): {
  ids: string[];
  count: number;
} {
  const distinct = [...new Set(values)];
  return { ids: distinct.slice(0, REFUSAL_LIST_MAX), count: distinct.length };
}

function forbidden(guard: RefusingGuard, request: { headers: Headers }): NextResponse {
  return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
}

/**
 * The AUTHZ-3 / REVOKE-1 subset test refused this request: audit it and return
 * the 403. `unheld` is what the row records as `metadata.unheldPermissions`,
 * so it holds keys read from the catalog (what a role or group confers), never
 * the raw strings a request body named. A caller whose subset test measures
 * the body itself (`roles/[id]/permissions`) passes the refused keys the
 * catalog knows and counts the rest in its metadata (F-15, as the success row
 * records only catalog-resolved keys, F-38).
 */
export async function refuseUnconferrable(
  guard: RefusingGuard,
  request: { headers: Headers },
  refusal: {
    /** The operation refused, e.g. `group_members_add`, `user_role_revoke`. */
    action: string;
    /**
     * F-32: the org the grant or revocation would have landed in, which is the
     * resource's org (the group's, the role's, the assignment's, the
     * invitation's), so that tenant's auditors see the attempt.
     */
    organizationId: string | null;
    unheld: ReadonlyArray<string>;
    /** The user whose authority would have changed, when the route resolved one. */
    appUserId?: string | null;
    email?: string | null;
    /**
     * What the request named (ids), a list through `boundedRequestList`.
     * Never a secret.
     */
    metadata?: Record<string, unknown>;
  },
): Promise<NextResponse> {
  await auditEvent({
    eventType: CONFERRAL_DENIED_EVENT,
    outcome: "denied",
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: refusal.appUserId ?? null,
    organizationId: refusal.organizationId,
    email: refusal.email ?? null,
    reason: UNHELD_PERMISSIONS_REASON,
    request,
    requestId: guard.requestId ?? null,
    metadata: {
      action: refusal.action,
      ...refusal.metadata,
      unheldPermissions: [...refusal.unheld],
    },
  });
  return forbidden(guard, request);
}

/**
 * The AUTHZ-2 rule (`requiresSuperadminForSharedTarget`) refused an
 * account-global action on a user shared with other orgs: audit it and return
 * the 403. `action` is the same name the handler passes `refuseOutrankingTarget`.
 * The row is stamped with the actor's org (F-32): the target was resolved in it.
 */
export async function refuseSharedTarget(
  guard: RefusingGuard,
  target: { appUserId: string; betterAuthUserId: string; primaryEmail: string },
  request: { headers: Headers },
  action: string,
): Promise<NextResponse> {
  await auditEvent({
    eventType: USER_ACTION_DENIED_EVENT,
    outcome: "denied",
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: actingOrganizationId(guard.access),
    email: target.primaryEmail,
    reason: SHARED_TARGET_REASON,
    request,
    requestId: guard.requestId ?? null,
    metadata: { action, targetBetterAuthUserId: target.betterAuthUserId },
  });
  return forbidden(guard, request);
}

/**
 * A `hasCrossOrgReach` gate refused a superadmin-only action (the permission
 * catalog, a tenant's lifecycle, the global email templates and sign-up
 * defaults, a global role or app, the Better Auth platform role): audit it and
 * return the 403. Stamped with the actor's org (F-32), so that tenant's
 * auditors see its admin reach for the platform. `metadata` (and `email`)
 * carry only what the caller sent, the ids in the URL or body, never a field
 * read from another tenant's row.
 */
export async function refuseWithoutCrossOrgReach(
  guard: RefusingGuard,
  request: { headers: Headers },
  action: string,
  metadata?: Record<string, unknown>,
  /** The address the request named (`POST /users`), so the explorer finds it by email. */
  email?: string,
): Promise<NextResponse> {
  await auditEvent({
    eventType: ACCESS_DENIED_EVENT,
    outcome: "denied",
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: actingOrganizationId(guard.access),
    email: email ?? null,
    reason: CROSS_ORG_REACH_REQUIRED_REASON,
    request,
    requestId: guard.requestId ?? null,
    metadata: { action, ...metadata },
  });
  return forbidden(guard, request);
}
