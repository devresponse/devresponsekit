import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { decideSecureAccess } from "@/lib/auth-status";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
import {
  consumeToken,
  rateLimitKey,
  type RateLimitOptions,
  DEFAULT_ADMIN_MUTATION_LIMIT,
} from "@/lib/admin/rate-limit.server";
import {
  hasBearerCredential,
  resolveCaller,
  type ResolvedCaller,
} from "@/lib/api-auth/resolve-caller.server";
import { scopesAuthorize } from "@/lib/api-auth/scopes";
import { problemResponse } from "@/lib/api-auth/problem";

/**
 * Authorization guard for the versioned REST surface (`/api/v1`). Mirrors
 * `requireAdminPermission` but speaks `application/problem+json` (design
 * §8.1) and exposes the resolved caller so adapters can audit + rate-limit
 * per credential. The actual authorization decision is identical: same
 * status/membership gate, same permission ∩ scope rule.
 */

export interface ApiGrant {
  caller: ResolvedCaller;
  requestId: string;
}

export type ApiGuardResult =
  | { ok: true; grant: ApiGrant }
  | { ok: false; response: NextResponse };

/**
 * Requires an authenticated caller holding `requiredPermission` (a single
 * admin permission key or an array, any of which satisfies). Account-level
 * scopes are not checked here — use {@link requireApiAccount} for the
 * self-service surface.
 */
export async function requireApiPermission(
  request: NextRequest,
  requiredPermission: string | string[],
): Promise<ApiGuardResult> {
  const required = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
  const requestId = getOrCreateRequestId(request);

  // CSRF origin guard applies only to ambient (cookie) credentials.
  if (!hasBearerCredential(request.headers)) {
    const origin = checkTrustedOrigin(request);
    if (!origin.ok) {
      return { ok: false, response: problemResponse("forbidden", 403, request, { requestId }) };
    }
  }

  const caller = await resolveCaller(request);
  if (!caller) {
    return {
      ok: false,
      response: problemResponse("unauthorized", 401, request, {
        requestId,
        headers: { "WWW-Authenticate": 'Bearer realm="devresponse-api"' },
      }),
    };
  }

  if (decideSecureAccess(caller.access.status, caller.access.membershipStatus) !== "allow") {
    return { ok: false, response: problemResponse("forbidden", 403, request, { requestId }) };
  }

  const granted = required.some(
    (perm) => caller.access.permissions.includes(perm) && scopesAuthorize(caller.grantedScopes, perm),
  );
  if (!granted) {
    await auditEvent({
      eventType: "api.access.denied",
      outcome: "denied",
      actorBetterAuthUserId: caller.betterAuthUserId,
      reason: "missing_permission_or_scope",
      request,
      requestId,
      metadata: { required, callerKind: caller.kind, credentialId: caller.credentialId },
    });
    return {
      ok: false,
      response: problemResponse("forbidden", 403, request, {
        requestId,
        detail: "The credential lacks the required permission or scope.",
      }),
    };
  }

  return { ok: true, grant: { caller, requestId } };
}

/**
 * Per-credential rate limiting for `/api/v1` mutations. Keys the bucket on
 * the credential id (api_key id / jwt jti / client id) when bearer, else
 * the principal — so one noisy key cannot exhaust the principal's whole
 * budget (design §10.4). Returns a problem+json 429 on deny, else null.
 */
export function enforceApiRateLimit(
  scope: string,
  grant: ApiGrant,
  request: NextRequest,
  options: RateLimitOptions = DEFAULT_ADMIN_MUTATION_LIMIT,
): NextResponse | null {
  const actorId = grant.caller.credentialId ?? grant.caller.betterAuthUserId;
  const result = consumeToken(rateLimitKey(scope, actorId), options);
  if (result.ok) return null;
  return problemResponse("rate_limited", 429, request, {
    requestId: grant.requestId,
    extra: { retryAfter: result.retryAfterSeconds },
    headers: { "Retry-After": String(result.retryAfterSeconds) },
  });
}
