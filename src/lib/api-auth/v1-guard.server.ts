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
  resolveCallerDetailed,
  type CallerRejectReason,
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

export type ApiGuardResult = { ok: true; grant: ApiGrant } | { ok: false; response: NextResponse };

/**
 * Requires an authenticated caller holding `requiredPermission` (a single
 * admin permission key or an array, any of which satisfies). Account-level
 * scopes are not checked here — the self-service `/api/v1/me*` surface uses
 * {@link requireApiAccount} (src/lib/account/guard.server.ts) instead, which
 * makes the same decision and speaks the same problem+json contract
 * (review #45; the reference this comment used to carry was #128's dangling
 * `requireApiAccount`, now a real symbol).
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

  const resolution = await resolveCallerDetailed(request);
  if (!resolution.ok) {
    return { ok: false, response: unauthenticatedResponse(request, requestId, resolution.reason) };
  }
  const caller = resolution.caller;

  if (decideSecureAccess(caller.access.status, caller.access.membershipStatus) !== "allow") {
    return { ok: false, response: problemResponse("forbidden", 403, request, { requestId }) };
  }

  const granted = required.some(
    (perm) =>
      caller.access.permissions.includes(perm) && scopesAuthorize(caller.grantedScopes, perm),
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
 * 401 for an unresolved caller. Two reasons get their own problem code so a
 * client can act on the difference instead of retrying blindly:
 *   - `credential_revoked` — the key / client behind a JWT was revoked or
 *     rotated since the token was minted (review #43); re-minting from the
 *     same credential will fail too.
 *   - `invalid_token` (RFC 6750 §3.1) — the JWT was minted for a different
 *     resource (review #50/#53); request one with `resource=<origin>/api/v1`.
 * Every other reason (no credential, bad signature, expired, path disabled,
 * banned owner) stays the generic `unauthorized`, so the response does not
 * distinguish an unknown credential from a disabled path.
 */
function unauthenticatedResponse(
  request: NextRequest,
  requestId: string,
  reason: CallerRejectReason,
): NextResponse {
  const realm = 'Bearer realm="devresponse-api"';
  if (reason === "credential_revoked") {
    return problemResponse("credential_revoked", 401, request, {
      requestId,
      detail: "The credential this token was minted from has been revoked or rotated.",
      headers: { "WWW-Authenticate": `${realm}, error="invalid_token"` },
    });
  }
  if (reason === "audience_mismatch") {
    return problemResponse("invalid_token", 401, request, {
      requestId,
      detail: "The token was not issued for this resource (audience mismatch).",
      headers: {
        "WWW-Authenticate": `${realm}, error="invalid_token", error_description="audience mismatch"`,
      },
    });
  }
  return problemResponse("unauthorized", 401, request, {
    requestId,
    headers: { "WWW-Authenticate": realm },
  });
}

/**
 * Per-credential rate limiting for `/api/v1` mutations. Keys the bucket on
 * the credential id (api_key id / jwt jti / client id) when bearer, else
 * the principal — so one noisy key cannot exhaust the principal's whole
 * budget (design §10.2). Returns a problem+json 429 on deny, else null.
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
