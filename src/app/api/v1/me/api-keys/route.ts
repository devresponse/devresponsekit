import type { NextRequest } from "next/server";
import { z } from "zod";
import { auditEvent } from "@/lib/audit.server";
import { requireApiAccount, tenantConfinement } from "@/lib/account/guard.server";
import {
  consumeToken,
  rateLimitKey,
  DEFAULT_ADMIN_MUTATION_LIMIT,
} from "@/lib/admin/rate-limit.server";
import { getServerEnv } from "@/lib/env";
import { createApiKey, listApiKeysForUser } from "@/lib/api-auth/api-keys.server";
import { normalizeScopes } from "@/lib/api-auth/scopes";
import { unissuableScopes } from "@/lib/api-auth/issuance";
import { IssuingCredentialRevokedError } from "@/lib/api-auth/issuance-fence.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";
import { withV1Route } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me/api-keys
 *
 * Lists the CALLER'S OWN API keys (design §5.4). Strictly self-scoped via
 * the account guard — no id is accepted; rows are keyed on the session/
 * credential principal. The secret and hash are never returned.
 *
 * IMP-1 — an impersonated session is ADMITTED here (the account panel has to
 * render, and the row set is non-secret metadata the target already sees) but
 * the listing is CONFINED to the organization the impersonated session
 * resolved, which the IMP-1 confinement caps to the impersonator's own
 * tenancy. `app_user_id` alone spans every tenant the target belongs to, so an
 * unconfined list would hand the admin the ids of that user's keys in tenants
 * the admin has no business in — the enumeration step of the rotate attack the
 * mutations below refuse outright. A confined session with no resolvable org
 * sees nothing.
 *
 * F-01 — a BEARER credential is confined the same way, to the org it acts in
 * ({@link tenantConfinement}). Unconfined, a key bound to org A listed the
 * owner's keys in every org, which was the enumeration step of the
 * cross-tenant rotate takeover.
 */
export const GET = withV1Route(async function GET(request: NextRequest) {
  const guard = await requireApiAccount(request, "account.read", { allowImpersonation: true });
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  // Called with ONE argument on the ordinary path so the unconfined listing
  // keeps its exact existing shape; the confinement is added only when the
  // caller is a borrowed session or a bearer credential.
  const confinement = tenantConfinement(actor);
  const items = confinement
    ? await listApiKeysForUser(actor.appUserId, confinement)
    : await listApiKeysForUser(actor.appUserId);
  return v1JsonResponse({ items }, request);
});

/**
 * POST /api/v1/me/api-keys
 *
 * Mints a new API key for the caller. The plaintext is returned EXACTLY
 * ONCE and never recoverable afterward.
 *
 * Threat / contract:
 *   - Requires the `account.apikeys.manage` scope (bearer) or a cookie
 *     session.
 *   - Requested scopes are checked against the caller's OWN authority
 *     ({@link unissuableScopes}, the shared issuance rule) so a credential
 *     can never mint a broader credential than itself (design §7, §10.3).
 *   - An IMPERSONATED session is refused (403). This is the account guard's
 *     DEFAULT, not a check written here (IMP-1): minting is where an
 *     impersonation would be laundered into a standalone bearer credential
 *     that outlives it and authenticates as the borrowed user.
 *   - A caller whose session or key is revoked while the request runs, by a
 *     password reset or set (F-10), gets `401 credential_revoked` and no key.
 */
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z.array(z.string().min(1).max(120)).max(64).default([]),
    expiresInDays: z.number().int().positive().max(3650).optional(),
  })
  .strict();

export const POST = withV1Route(async function POST(request: NextRequest) {
  const guard = await requireApiAccount(request, "account.apikeys.manage");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  // Throttle credential minting per principal (sec-2): this is a sensitive
  // credential-issuing operation. Reuses the per-actor mutation token bucket.
  const limit = consumeToken(
    rateLimitKey("api.me.apikeys", actor.betterAuthUserId),
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (!limit.ok) {
    return problemResponse("rate_limited", 429, request, { headers: { "Retry-After": "2" } });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return problemResponse("invalid_request", 400, request);
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return problemResponse("invalid_request", 400, request, { detail: "Invalid request body." });
  }

  const scopes = normalizeScopes(parsed.data.scopes);
  // The key authenticates as the caller themselves, so only the actor bound
  // can refuse here — but every issuance path runs the one rule.
  const ungrantable = unissuableScopes({
    issuer: {
      appUserId: actor.appUserId,
      permissions: actor.access.permissions,
      grantedScopes: actor.grantedScopes,
      impersonatorId: actor.impersonatorId,
    },
    ownerAppUserId: actor.appUserId,
    scopes,
  });
  if (ungrantable.length > 0) {
    return problemResponse("invalid_scope", 403, request, {
      detail: "You cannot grant scopes you do not hold.",
      extra: { ungrantableScopes: ungrantable },
    });
  }

  const env = getServerEnv();
  const ttlDays = parsed.data.expiresInDays ?? env.API_KEY_DEFAULT_TTL_DAYS ?? null;
  const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) : null;

  // F-10: the insert runs behind the issuance fence, so a key cannot be born
  // after a password reset or set revoked the caller's session or key: the
  // eviction either revokes this key too or this request is refused here.
  let created;
  try {
    created = await createApiKey({
      ownerAppUserId: actor.appUserId,
      organizationId: actor.access.organizationId,
      name: parsed.data.name,
      scopes,
      expiresAt,
      createdByAppUserId: actor.appUserId,
      issuedVia: actor.source ?? null,
    });
  } catch (error) {
    if (!(error instanceof IssuingCredentialRevokedError)) throw error;
    await auditEvent({
      eventType: "api_key.create_denied",
      outcome: "denied",
      reason: "issuing_credential_revoked",
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: actor.appUserId,
      organizationId: actor.access.organizationId,
      request,
      metadata: { callerKind: actor.callerKind },
    });
    return problemResponse("credential_revoked", 401, request, {
      detail: "The credential this request authenticated with was revoked while it ran.",
      headers: { "WWW-Authenticate": 'Bearer realm="devresponse-api", error="invalid_token"' },
    });
  }

  await auditEvent({
    eventType: "api_key.created",
    outcome: "success",
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    organizationId: actor.access.organizationId,
    request,
    // NEVER the plaintext or hash — only non-secret metadata.
    metadata: { apiKeyId: created.id, scopes, prefix: created.key_prefix },
  });

  return v1JsonResponse(
    {
      id: created.id,
      name: created.name,
      prefix: created.key_prefix,
      scopes: created.scopes,
      expiresAt: created.expires_at,
      // Shown ONCE. Persist it now — it cannot be retrieved again.
      key: created.plaintext,
    },
    request,
    { status: 201 },
  );
});
