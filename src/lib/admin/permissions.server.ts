import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { getCurrentSession } from "@/lib/auth-guard";
import {
  decideSecureAccess,
  getUserAccessContext,
  type UserAccessContext,
} from "@/lib/auth-status";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";

/**
 * Result of a successful permission check. Callers receive the resolved
 * Better Auth session id alongside the application access context so
 * they can audit the actor and continue with their own logic.
 *
 * `requestId` is the correlation id surfaced via `x-request-id` on the
 * eventual response and on every audit row this handler writes — pass
 * it explicitly to the {@link auditEvent} / `auditUserAction` helpers
 * so they share the same id (docs/admin-manager.md §12).
 */
export interface AdminPermissionGrant {
  betterAuthUserId: string;
  access: UserAccessContext;
  requestId: string;
}

/**
 * Result of a failed permission check. Returned as a structured value so
 * route handlers can distinguish "deny" from "allow" without `instanceof`
 * checks against `NextResponse`.
 */
export interface AdminPermissionDenial {
  response: NextResponse;
}

export type AdminPermissionResult = AdminPermissionGrant | AdminPermissionDenial;

/**
 * Returns true when the result is a denial (carries a ready-to-return
 * `NextResponse`).
 */
export function isAdminPermissionDenial(
  result: AdminPermissionResult,
): result is AdminPermissionDenial {
  return "response" in result;
}

/**
 * Centralized authorization for every Administrator-app server entry
 * point (RSC layout/page, API route handler, server action). Validates
 * the Better Auth session, the application user is `active` with an
 * `active` membership, and the caller holds the requested permission.
 *
 * Threat / contract:
 *   - Unauthenticated callers receive 401.
 *   - Callers whose status/membership blocks them receive 403.
 *   - Callers missing the permission receive 403 AND an audit row with
 *     `outcome: "denied"` so denied attempts are captured for ops.
 *   - On success we return the resolved access context so handlers can
 *     reuse it without a second DB round-trip.
 *
 * `requiredPermission` accepts a single key or an array; for an array,
 * any one match satisfies the check (used by the layout, which only
 * needs to know the caller is an admin of *some* kind).
 */
export async function requireAdminPermission(
  request: NextRequest | { headers: Headers; method?: string },
  requiredPermission: string | string[],
): Promise<AdminPermissionResult> {
  const required = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
  const requestId = getOrCreateRequestId(request);

  // §14 — Origin/Referer defence-in-depth on unsafe methods. Performed
  // BEFORE session resolution so an unauthenticated cross-origin probe
  // cannot trigger a database round-trip.
  const origin = checkTrustedOrigin(request as { method?: string; headers: Headers });
  if (!origin.ok) {
    await auditEvent({
      eventType: "administrator.access.denied",
      outcome: "denied",
      reason: origin.reason ?? "untrusted_origin",
      request,
      requestId,
      metadata: { required },
    });
    return {
      response: adminErrorResponse("untrusted_origin", 403, request, { requestId }),
    };
  }

  const session = await getCurrentSession();
  if (!session) {
    return {
      response: adminErrorResponse("unauthenticated", 401, request, { requestId }),
    };
  }

  const access = await getUserAccessContext(session.user.id);
  const decision = decideSecureAccess(access.status, access.membershipStatus);
  if (decision !== "allow") {
    return {
      response: adminErrorResponse("forbidden", 403, request, { requestId }),
    };
  }

  const granted = required.some((perm) => access.permissions.includes(perm));
  if (!granted) {
    await auditEvent({
      eventType: "administrator.access.denied",
      outcome: "denied",
      actorBetterAuthUserId: session.user.id,
      reason: "missing_admin_permission",
      request,
      requestId,
      metadata: { required },
    });
    return {
      response: adminErrorResponse("forbidden", 403, request, { requestId }),
    };
  }

  return { betterAuthUserId: session.user.id, access, requestId };
}

/**
 * Server-component variant of {@link requireAdminPermission}. Returns
 * either a grant or a sentinel value so layouts can decide whether to
 * call `notFound()` (giving 404 indistinguishability per §6.2 of the
 * plan) instead of leaking the existence of the route.
 */
export async function checkAdminPermissionServer(
  requiredPermission: string | string[],
): Promise<Omit<AdminPermissionGrant, "requestId"> | "denied" | "unauthenticated"> {
  const required = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];

  const session = await getCurrentSession();
  if (!session) return "unauthenticated";

  const access = await getUserAccessContext(session.user.id);
  const decision = decideSecureAccess(access.status, access.membershipStatus);
  if (decision !== "allow") return "denied";

  const granted = required.some((perm) => access.permissions.includes(perm));
  if (!granted) return "denied";

  return { betterAuthUserId: session.user.id, access };
}

/**
 * The full set of administrator permission keys (plan §6.1) and the
 * "any admin" superset used by the layout. Sourced from the
 * non-`server-only` catalog module so seed scripts can share the same
 * definitions without resolving the `server-only` sentinel.
 */
export { ADMIN_PERMISSION_CATALOG, ANY_ADMIN_PERMISSION } from "./permissions";
