import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { getServerEnv } from "@/lib/env";
import { consumeToken, rateLimitKey } from "@/lib/admin/rate-limit.server";
import type { RateLimitResult } from "@/lib/admin/rate-limit.server";
import { consumeSharedToken } from "@/lib/admin/rate-limit-shared.server";
import { clientIpKey } from "@/lib/client-ip";
import { rateLimitDenialsTotal } from "@/lib/observability/metrics.server";
import { verifyClientCredentials } from "@/lib/api-auth/oauth-clients.server";
import { verifyApiKey } from "@/lib/api-auth/api-keys.server";
import { isBetterAuthUserBanned } from "@/lib/api-auth/ban-status.server";
import { mintAccessToken, type TokenCredentialRef } from "@/lib/api-auth/jwt.server";
import { audienceForResource, resolveRequestedResource } from "@/lib/api-auth/resources";
import { normalizeScopes, scopesAuthorize } from "@/lib/api-auth/scopes";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/token
 *
 * OAuth2-style token endpoint (design §6.1). Exchanges a long-lived
 * credential for a short-lived JWT access token, so high-throughput
 * clients verify by signature (JWKS) instead of a per-request DB lookup.
 *
 * Grants:
 *   - `client_credentials` — `client_id` + `client_secret`.
 *   - `api_key`            — `api_key` (a `drk_…` key).
 *
 * Optional `scope` down-scopes the token to a subset of the credential's
 * scopes. Optional `resource` (RFC 8707, review #50/#53) selects the
 * audience: `<origin>/api/v1` (the default when omitted) or
 * `<origin>/api/mcp`; anything else is `invalid_target`. The endpoint is
 * itself unauthenticated (the credential IS the auth) and rate-limited per
 * trusted client IP, per VERIFIED credential, and deployment-wide. Sets
 * `Cache-Control: no-store`.
 */
// Pre-auth bucket, keyed on the trusted client IP (P2-4). Never keyed on a
// client-supplied value: `client_id` is public and unauthenticated, so a
// client_id-keyed pre-auth bucket let anyone who knew a victim's id drain it
// from any network, let an attacker escape per-IP throttling by rotating
// ids, and turned attacker-chosen strings into limiter keys (review #11).
const TOKEN_IP_LIMIT = { capacity: 10, refillPerSec: 0.5 };
// Post-auth bucket, keyed on the credential ONLY AFTER it verified. Gives a
// fair per-credential share behind a shared egress IP without letting an
// unverified request allocate a bucket for an id it does not hold. Stays
// IN-PROCESS: the fan-out is bounded by the credentials the caller holds.
const TOKEN_CREDENTIAL_LIMIT = { capacity: 10, refillPerSec: 0.5 };
// P2-4: a coarse GLOBAL floor independent of any client-supplied value, so
// a distributed credential-stuffing run spoofing XFF still hits a
// deployment-wide ceiling (~5 req/s sustained, 300 burst). Both pre-auth
// buckets consume from the SHARED Postgres bucket (review #98): in memory
// they were per lambda, so "deployment-wide" really meant "per invocation".
const TOKEN_GLOBAL_LIMIT = { capacity: 300, refillPerSec: 5 };
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Problem+json 429 for a denied limiter check. Counts the denial for the
 * `/api/metrics` scrape (the route calls `consumeToken` directly because
 * `enforceRateLimit` speaks the AdminError envelope, not problem+json) and
 * carries the bucket's real `Retry-After`.
 */
function rateLimitedResponse(
  request: NextRequest,
  result: Extract<RateLimitResult, { ok: false }>,
) {
  rateLimitDenialsTotal.inc({ scope: "api.token" });
  return problemResponse("rate_limited", 429, request, {
    extra: { retryAfter: result.retryAfterSeconds },
    headers: { ...NO_STORE, "Retry-After": String(result.retryAfterSeconds) },
  });
}

async function parseBody(request: NextRequest): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) if (typeof v === "string") out[k] = v;
    return out;
  }
  // Default to form-encoded per the OAuth2 spec.
  const text = await request.text().catch(() => "");
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

export async function POST(request: NextRequest) {
  const env = getServerEnv();
  if (!env.API_JWT_ENABLED) {
    return problemResponse("unsupported_grant_type", 400, request, {
      detail: "JWT access tokens are not enabled on this deployment.",
      headers: NO_STORE,
    });
  }

  const body = await parseBody(request);
  const grantType = body.grant_type;

  // Rate-limit before any crypto / DB work. Two pre-auth layers: a global
  // floor that a spoofed XFF cannot escape, AND a per-IP bucket keyed on the
  // trusted proxy hop (P2-4). Nothing the client sends in the body reaches a
  // limiter key before the credential verifies (review #11). Both are shared
  // across instances (review #98) — one DB round trip each, before the
  // credential lookup that would cost one anyway.
  const globalCheck = await consumeSharedToken(
    rateLimitKey("api.token", "__global__"),
    TOKEN_GLOBAL_LIMIT,
  );
  if (!globalCheck.ok) return rateLimitedResponse(request, globalCheck);
  const ipCheck = await consumeSharedToken(
    rateLimitKey("api.token", clientIpKey(request.headers)),
    TOKEN_IP_LIMIT,
  );
  if (!ipCheck.ok) return rateLimitedResponse(request, ipCheck);

  let principalBetterAuthUserId: string;
  let credentialScopes: string[];
  let organizationId: string | null;
  let credentialLabel: string;
  // Source credential → `cid` claim, so the resolver can retire the token the
  // moment the key / client is revoked or rotated (review #43).
  let credential: TokenCredentialRef;
  // A token must never outlive the key it was minted from (review #48).
  // `null` = the credential carries no expiry of its own (clients never do).
  let credentialExpiresAt: Date | null = null;

  if (grantType === "client_credentials") {
    if (!body.client_id || !body.client_secret) {
      return problemResponse("invalid_client", 401, request, { headers: NO_STORE });
    }
    const verified = await verifyClientCredentials(body.client_id, body.client_secret);
    if (!verified) return problemResponse("invalid_client", 401, request, { headers: NO_STORE });
    principalBetterAuthUserId = verified.betterAuthUserId;
    credentialScopes = verified.scopes;
    organizationId = verified.organizationId;
    credentialLabel = body.client_id;
    credential = { kind: "oauth_client", id: verified.clientRowId };
  } else if (grantType === "api_key") {
    if (!env.API_KEYS_ENABLED) {
      return problemResponse("unsupported_grant_type", 400, request, {
        detail: "API key grants are not enabled on this deployment.",
        headers: NO_STORE,
      });
    }
    if (!body.api_key) {
      return problemResponse("invalid_client", 401, request, { headers: NO_STORE });
    }
    const verified = await verifyApiKey(body.api_key);
    if (!verified) return problemResponse("invalid_client", 401, request, { headers: NO_STORE });
    principalBetterAuthUserId = verified.betterAuthUserId;
    credentialScopes = verified.scopes;
    organizationId = verified.organizationId;
    credentialLabel = verified.id;
    credential = { kind: "api_key", id: verified.id };
    credentialExpiresAt = verified.expiresAt;
  } else {
    return problemResponse("unsupported_grant_type", 400, request, { headers: NO_STORE });
  }

  // Per-credential bucket, allocated only now that the credential verified:
  // a wrong-secret request never touches it, so a remote party holding only
  // a victim's public client_id cannot drain the victim's budget, and
  // unknown ids never create limiter entries (review #11).
  const credentialCheck = consumeToken(
    rateLimitKey("api.token.credential", credentialLabel),
    TOKEN_CREDENTIAL_LIMIT,
  );
  if (!credentialCheck.ok) return rateLimitedResponse(request, credentialCheck);

  // The principal must still be an active member OF THE CREDENTIAL'S BOUND
  // ORG — evaluate the issuance gate against that org, not the active_org
  // cookie / earliest membership, so a token is never minted for a tenant the
  // principal is no longer active in (MACHINE-1, consistent with the use-time
  // resolution in resolveCaller).
  const access = await getUserAccessContext(principalBetterAuthUserId, { organizationId });
  if (decideSecureAccess(access.status, access.membershipStatus) !== "allow") {
    return problemResponse("invalid_client", 401, request, {
      detail: "The credential's principal is not an active member.",
      headers: NO_STORE,
    });
  }

  // MAPI-2: decideSecureAccess is status/membership-based and never reads the
  // Better Auth `banned` flag, so a banned principal would still mint a token
  // here — dead-on-arrival at resolveCaller, but it should never be issued.
  // Reject + audit at mint time. Applies to both grant types (each resolved a
  // betterAuthUserId above). 401 invalid_client matches the other failed-
  // credential responses on this endpoint.
  if (await isBetterAuthUserBanned(principalBetterAuthUserId)) {
    await auditEvent({
      eventType: "token.denied",
      outcome: "denied",
      actorBetterAuthUserId: principalBetterAuthUserId,
      appUserId: access.appUserId,
      organizationId,
      reason: "principal_banned",
      request,
      metadata: { grantType, credential: credentialLabel },
    });
    return problemResponse("invalid_client", 401, request, {
      detail: "The credential's principal is banned.",
      headers: NO_STORE,
    });
  }

  // Optional down-scoping: requested scopes must be a subset of the
  // credential's scopes (never a superset).
  const requested = normalizeScopes(body.scope);
  let effectiveScopes = credentialScopes;
  if (requested.length > 0) {
    const exceeded = requested.filter((s) => !scopesAuthorize(credentialScopes, s));
    if (exceeded.length > 0) {
      return problemResponse("invalid_scope", 400, request, {
        extra: { exceededScopes: exceeded },
        headers: NO_STORE,
      });
    }
    effectiveScopes = requested;
  }

  // RFC 8707 resource indicator → audience (review #50/#53). The allow-list
  // is derived from the deployment's own origin, never from the request, and
  // an unknown resource is refused with the RFC's `invalid_target` rather
  // than silently minted for the default. Omitted → the v1 API audience,
  // exactly what every pre-existing client already receives.
  const resource = resolveRequestedResource(body.resource, env.BETTER_AUTH_URL);
  if (!resource) {
    return problemResponse("invalid_target", 400, request, {
      detail: "The requested resource is not one this authorization server issues tokens for.",
      headers: NO_STORE,
    });
  }
  const audience = audienceForResource(resource.kind, env);

  // Cap the token's lifetime at the key's own expiry (review #48): a JWT that
  // outlives its source key would let a "this key expires at midnight" policy
  // leak by up to a full TTL. `verifyApiKey` already refused a key past its
  // `expires_at`; the remaining edge is a key expiring within the next second,
  // whose floor()'d remaining life is 0 — never mint a 0/negative TTL, refuse
  // it the same way an expired key is refused.
  let ttlSeconds = env.API_JWT_ACCESS_TTL_SECONDS;
  if (credentialExpiresAt) {
    const remaining = Math.floor((credentialExpiresAt.getTime() - Date.now()) / 1000);
    if (remaining < 1) {
      return problemResponse("invalid_client", 401, request, {
        detail: "The API key has expired.",
        headers: NO_STORE,
      });
    }
    ttlSeconds = Math.min(ttlSeconds, remaining);
  }

  const jti = crypto.randomUUID();
  const minted = await mintAccessToken({
    subject: principalBetterAuthUserId,
    scopes: effectiveScopes,
    organizationId,
    jti,
    ttlSeconds,
    audience,
    credential,
  });

  await auditEvent({
    eventType: "token.issued",
    outcome: "success",
    actorBetterAuthUserId: principalBetterAuthUserId,
    appUserId: access.appUserId,
    organizationId,
    request,
    metadata: {
      grantType,
      credential: credentialLabel,
      jti,
      scopes: effectiveScopes,
      resource: resource.resource,
      audience,
      expiresIn: minted.expiresInSeconds,
    },
  });

  return v1JsonResponse(
    {
      access_token: minted.token,
      token_type: "Bearer",
      expires_in: minted.expiresInSeconds,
      scope: minted.scopes.join(" "),
    },
    request,
    { headers: NO_STORE },
  );
}
