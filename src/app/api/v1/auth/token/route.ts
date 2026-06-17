import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { getServerEnv } from "@/lib/env";
import { consumeToken, rateLimitKey } from "@/lib/admin/rate-limit.server";
import { clientIpKey } from "@/lib/client-ip";
import { verifyClientCredentials } from "@/lib/api-auth/oauth-clients.server";
import { verifyApiKey } from "@/lib/api-auth/api-keys.server";
import { mintAccessToken } from "@/lib/api-auth/jwt.server";
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
 * scopes. The endpoint is itself unauthenticated (the credential IS the
 * auth) and rate-limited per client/IP. Sets `Cache-Control: no-store`.
 */
const TOKEN_LIMIT = { capacity: 10, refillPerSec: 0.5 };
// P2-4: a coarse GLOBAL floor independent of any client-supplied value, so
// a distributed credential-stuffing run rotating client_ids / spoofing XFF
// still hits a deployment-wide ceiling (~5 req/s sustained, 300 burst).
const TOKEN_GLOBAL_LIMIT = { capacity: 300, refillPerSec: 5 };
const NO_STORE = { "Cache-Control": "no-store" };

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

  // Rate-limit before any crypto / DB work. Two layers: a per-credential/IP
  // bucket (keyed on the trusted client IP, P2-4) AND a global floor that a
  // spoofed XFF / rotating client_id cannot escape.
  if (!consumeToken(rateLimitKey("api.token", "__global__"), TOKEN_GLOBAL_LIMIT).ok) {
    return problemResponse("rate_limited", 429, request, {
      headers: { ...NO_STORE, "Retry-After": "2" },
    });
  }
  const limiterId = body.client_id ?? clientIpKey(request.headers);
  if (!consumeToken(rateLimitKey("api.token", limiterId), TOKEN_LIMIT).ok) {
    return problemResponse("rate_limited", 429, request, {
      headers: { ...NO_STORE, "Retry-After": "2" },
    });
  }

  let principalBetterAuthUserId: string;
  let credentialScopes: string[];
  let organizationId: string | null;
  let credentialLabel: string;

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
  } else {
    return problemResponse("unsupported_grant_type", 400, request, { headers: NO_STORE });
  }

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

  const jti = crypto.randomUUID();
  const minted = await mintAccessToken({
    subject: principalBetterAuthUserId,
    scopes: effectiveScopes,
    organizationId,
    jti,
  });

  await auditEvent({
    eventType: "token.issued",
    outcome: "success",
    actorBetterAuthUserId: principalBetterAuthUserId,
    appUserId: access.appUserId,
    organizationId,
    request,
    metadata: { grantType, credential: credentialLabel, jti, scopes: effectiveScopes },
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
