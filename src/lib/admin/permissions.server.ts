import "server-only";
import { headers } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess, type UserAccessContext } from "@/lib/auth-status";
import { getSessionAccessContext } from "@/lib/session-access.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { logPreAuthRefusal } from "@/lib/observability/pre-auth-refusal.server";
import { REQUEST_PATH_HEADER, normalizeRequestPath } from "@/lib/request-id";
import {
  hasBearerCredential,
  resolveCaller,
  type CallerKind,
} from "@/lib/api-auth/resolve-caller.server";
import { scopesAuthorize } from "@/lib/api-auth/scopes";
import type { CallerSource } from "@/lib/api-auth/issuance-fence.server";
import { actingOrganizationId, isSuperadmin } from "@/lib/admin/access-scope.server";

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
  /** How the caller authenticated — cookie, API key, or JWT. */
  callerKind: CallerKind;
  /** api_key id / jwt jti when bearer-authenticated; null for cookies. */
  credentialId: string | null;
  /**
   * The credential the request authenticated with, re-checked when a route
   * issues a credential (F-10, `ResolvedCaller.source`).
   */
  source?: CallerSource | null;
  /** Credential scopes (null for cookies = full user authority). */
  grantedScopes: string[] | null;
  /**
   * The impersonating admin's id when the caller is an impersonated session,
   * else `null` (always `null` for bearer credentials). An impersonated
   * session carries the BORROWED user's identity in `access`, so a route that
   * must tell the two apart — credential issuance (F-01) — reads it here.
   */
  impersonatorId: string | null;
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
 *   - A cookie request from an untrusted origin receives 403
 *     `untrusted_origin`, logged + counted but NOT audited (F-15: it is
 *     refused before the caller is known — see `logPreAuthRefusal`).
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

  // §4 — Origin/Referer defence-in-depth on unsafe methods. CSRF only
  // applies to AMBIENT credentials (cookies); a bearer token cannot be
  // attached by an attacker's page, so the origin guard is skipped for
  // bearer callers (design §10.3). Performed BEFORE caller resolution so
  // an unauthenticated cross-origin cookie probe cannot trigger a DB
  // round-trip.
  //
  // F-15: and so it cannot trigger a DB WRITE either. Nothing about the
  // caller is known yet, so this refusal used to insert one permanent
  // `app_audit_events` row per anonymous request (a curl loop with an 8 KB
  // User-Agent grew the append-only table at will). It is logged + counted
  // instead, like every other origin guard; the authenticated denials below
  // stay audited.
  if (!hasBearerCredential(request.headers)) {
    const origin = checkTrustedOrigin(request as { method?: string; headers: Headers });
    if (!origin.ok) {
      logPreAuthRefusal({
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
  }

  const caller = await resolveCaller(request);
  if (!caller) {
    return {
      response: adminErrorResponse("unauthenticated", 401, request, { requestId }),
    };
  }

  const decision = decideSecureAccess(caller.access.status, caller.access.membershipStatus);
  if (decision !== "allow") {
    return {
      response: adminErrorResponse("forbidden", 403, request, { requestId }),
    };
  }

  // The caller must hold the permission AND, for bearer credentials, the
  // credential's scopes must authorize it (scopes ⊆ permissions — a key
  // can never out-scope its owner; design §7).
  // A SUPERADMIN passes every admin permission check regardless of the active
  // org (the superuser marker is global — see getUserAccessContext). Bearer
  // credentials are still bounded by their scopes: a key can never out-scope
  // its owner, even a superuser owner (design §7).
  //
  // MACHINE-2 audit: this stays on `isSuperadmin`, NOT `hasCrossOrgReach`. It
  // answers a CAPABILITY question — "does this principal hold the permission
  // at all" — and an org-bound superuser genuinely does hold it inside its
  // bound tenant (`getUserAccessContext` expands the marker on that path too).
  // Narrowing it here would deny the request outright rather than scope it, and
  // would be redundant anyway since the expansion already puts every `admin.*`
  // key in `permissions`. WHICH ROWS the request may then touch is the tenant
  // boundary's job, and that is capped in `access-scope.server`.
  const granted = required.some(
    (perm) =>
      (isSuperadmin(caller.access) || caller.access.permissions.includes(perm)) &&
      scopesAuthorize(caller.grantedScopes, perm),
  );
  if (!granted) {
    await auditEvent({
      eventType: "administrator.access.denied",
      outcome: "denied",
      actorBetterAuthUserId: caller.betterAuthUserId,
      // F-32: the org the caller was acting in (its active or bound org), so
      // that tenant's auditors see its members probing the console. `null` for
      // an unbound superadmin, never its active-org cookie. The RSC twin below
      // and the `/api/v1` guard stamp theirs the same way.
      organizationId: actingOrganizationId(caller.access),
      reason: "missing_admin_permission",
      request,
      requestId,
      metadata: { required, callerKind: caller.kind, credentialId: caller.credentialId },
    });
    return {
      response: adminErrorResponse("forbidden", 403, request, { requestId }),
    };
  }

  return {
    betterAuthUserId: caller.betterAuthUserId,
    access: caller.access,
    requestId,
    callerKind: caller.kind,
    credentialId: caller.credentialId,
    source: caller.source ?? null,
    grantedScopes: caller.grantedScopes,
    impersonatorId: caller.impersonatorId,
  };
}

/**
 * Server-component variant of {@link requireAdminPermission}. Returns
 * either a grant or a sentinel value so layouts can decide whether to
 * call `notFound()` (giving 404 indistinguishability per
 * docs/admin-manager.md §6.2) instead of leaking the existence of the
 * route.
 */
export async function checkAdminPermissionServer(
  requiredPermission: string | string[],
): Promise<{ betterAuthUserId: string; access: UserAccessContext } | "denied" | "unauthenticated"> {
  const required = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];

  const session = await getCurrentSession();
  if (!session) return "unauthenticated";

  // IMP-1: the RSC admin gate resolves the context THROUGH the session, so an
  // impersonated browser is confined to the impersonator's own tenancy.
  const access = await getSessionAccessContext(session);
  const decision = decideSecureAccess(access.status, access.membershipStatus);
  if (decision !== "allow") {
    await auditRscDenial(required, session.user.id, decision, actingOrganizationId(access));
    return "denied";
  }

  const granted = required.some(
    (perm) => isSuperadmin(access) || access.permissions.includes(perm),
  );
  if (!granted) {
    await auditRscDenial(
      required,
      session.user.id,
      "missing_admin_permission",
      actingOrganizationId(access),
    );
    return "denied";
  }

  return { betterAuthUserId: session.user.id, access };
}

/**
 * Writes the `administrator.access.denied` row for an RSC denial (review #74).
 *
 * The route-handler path in {@link requireAdminPermission} has always audited
 * its denials, but the RSC path — the one an operator actually walks into by
 * typing a URL — silently `notFound()`d. Denied navigation is explicitly in
 * the audit contract (docs/admin-manager.md §12), so a probe of
 * `/app/administrator/*` left no trace at all while the equivalent `fetch` of
 * `/api/administrator/*` left one. Same event type, same outcome, same reason
 * vocabulary; `surface: "rsc"` and the pathname distinguish it from the route
 * row so an operator can tell a URL probe from an API probe.
 *
 * Deduped per request on `${reason}|${required}`, keyed by the request's
 * `Headers` object — the same per-request carrier `getOrCreateRequestId`
 * memoizes on. What that suppresses is a REPEAT of the same guard: the same
 * required set failing the same way twice in one render (a layout re-run
 * under the not-found boundary, a nested guard restating its parent's key).
 * It does NOT collapse a layout+page navigation into one row, and must not:
 * the administrator layout guards on `[...ANY_ADMIN_PERMISSION]` while the
 * page guards on a single key, so a denied navigation legitimately records
 * TWO rows — "no admin permission at all" and "not this page's permission"
 * — which are different facts about the same probe. Two genuinely different
 * denials in one render both land, by the same rule.
 */
const rscDenialsSeen = new WeakMap<object, Set<string>>();

async function auditRscDenial(
  required: string[],
  betterAuthUserId: string,
  reason: string,
  organizationId: string | null,
): Promise<void> {
  const requestHeaders = await headers();
  const dedupeKey = `${reason}|${required.join(",")}`;
  let seen = rscDenialsSeen.get(requestHeaders);
  if (!seen) {
    seen = new Set();
    rscDenialsSeen.set(requestHeaders, seen);
  }
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);

  const request = { headers: requestHeaders as unknown as Headers };
  await auditEvent({
    eventType: "administrator.access.denied",
    outcome: "denied",
    actorBetterAuthUserId: betterAuthUserId,
    organizationId,
    reason,
    request,
    requestId: getOrCreateRequestId(request),
    metadata: {
      required,
      surface: "rsc",
      // `proxy.ts` stamps the resolved pathname on the forwarded request
      // headers; it is the only thing that says WHICH admin page was probed.
      // Normalized, never stored raw: on a path the proxy matcher does not
      // cover the value is whatever the CLIENT sent, and this row goes into
      // `app_audit_events` — append-only and trigger-protected, so an
      // unbounded arbitrary string would be permanent. `normalizeRequestPath`
      // caps the length and rejects anything that is not a single-line,
      // origin-relative path (→ `null`).
      path: normalizeRequestPath(requestHeaders.get(REQUEST_PATH_HEADER)),
    },
  });
}

/**
 * The full set of administrator permission keys (docs/admin-manager.md
 * §6.1) and the "any admin" superset used by the layout. Sourced from the
 * non-`server-only` catalog module so seed scripts can share the same
 * definitions without resolving the `server-only` sentinel.
 */
export { ADMIN_PERMISSION_CATALOG, ANY_ADMIN_PERMISSION } from "./permissions";
