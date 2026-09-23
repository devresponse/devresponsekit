import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { isWithinTenant, requireApiAccount, tenantConfinement } from "@/lib/account/guard.server";
import { unissuableScopes } from "@/lib/api-auth/issuance";
import { getApiKeyById, rotateApiKey } from "@/lib/api-auth/api-keys.server";
import {
  consumeToken,
  rateLimitKey,
  DEFAULT_ADMIN_MUTATION_LIMIT,
} from "@/lib/admin/rate-limit.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/me/api-keys/[id]/rotate
 *
 * Rotates one of the caller's own keys: issues a fresh secret (same
 * scopes/expiry) and revokes the old one atomically (design §5.3). The
 * new plaintext is returned ONCE.
 *
 * (The design wrote this as `:rotate`; Next.js path segments cannot
 * contain `:`, so it is exposed as a `/rotate` sub-resource.)
 *
 * An IMPERSONATED session is refused (403) by the account guard's default
 * (IMP-1). This is the sharpest edge of the whole self-service surface: the
 * ownership check passes (the session IS the target), `rotateApiKey` re-mints
 * with the EXISTING `organization_id` and the ORIGINAL scopes, and the new
 * plaintext is returned once — so an administrator would walk away with a
 * standalone bearer credential carrying the borrowed user's authority in the
 * borrowed user's tenant, outliving the impersonation and attributed to
 * someone else.
 *
 * F-01 — two more bounds, both because a rotation IS an issuance:
 *   - a BEARER caller only reaches keys in the org it acts in
 *     ({@link tenantConfinement}); a key bound to org A rotating the owner's
 *     org-B key handed back that tenant's authority;
 *   - for a bearer caller, the key's scopes must be grantable by the CALLING
 *     credential ({@link unissuableScopes}), so a narrow key cannot rotate its
 *     owner's broad one and receive it.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiAccount(request, "account.apikeys.manage");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  // Throttle credential rotation per principal (sec-2).
  const limit = consumeToken(
    rateLimitKey("api.me.apikeys", actor.betterAuthUserId),
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (!limit.ok) {
    return problemResponse("rate_limited", 429, request, { headers: { "Retry-After": "2" } });
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);

  const key = await getApiKeyById(id);
  if (
    !key ||
    key.app_user_id !== actor.appUserId ||
    !isWithinTenant(key.organization_id, tenantConfinement(actor))
  ) {
    return problemResponse("not_found", 404, request);
  }
  // An inactive key answers 409 whatever its scopes — never a scope denial.
  if (key.status !== "active") {
    return problemResponse("conflict", 409, request, {
      detail: "Key is not active and cannot be rotated.",
    });
  }

  // A rotation re-issues the key's ORIGINAL scopes to the caller, so a BEARER
  // caller is bounded exactly like a mint: a key scoped only
  // `account.apikeys.manage` must not rotate its owner's `admin.*` key and
  // walk away with it. An ordinary cookie session is the owner with their
  // full authority in whichever org the key lives in (its successor is exactly
  // as capable as the key it replaces), and `access.permissions` there are the
  // ACTIVE org's — so bounding it would only refuse the owner their own keys
  // in their other orgs, not stop anyone.
  const unissuable =
    actor.grantedScopes === null
      ? []
      : unissuableScopes({
          issuer: {
            appUserId: actor.appUserId,
            permissions: actor.access.permissions,
            grantedScopes: actor.grantedScopes,
            impersonatorId: actor.impersonatorId,
          },
          ownerAppUserId: actor.appUserId,
          scopes: key.scopes,
        });
  if (unissuable.length > 0) {
    await auditEvent({
      eventType: "api_key.rotate_denied",
      outcome: "denied",
      reason: "scope_not_grantable",
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: actor.appUserId,
      organizationId: key.organization_id,
      request,
      metadata: { apiKeyId: id, ungrantableScopes: unissuable, callerKind: actor.callerKind },
    });
    return problemResponse("invalid_scope", 403, request, {
      detail: "You cannot rotate a key carrying scopes you cannot grant.",
      extra: { ungrantableScopes: unissuable },
    });
  }

  const rotated = await rotateApiKey(id, actor.appUserId);
  if (!rotated) {
    return problemResponse("conflict", 409, request, {
      detail: "Key is not active and cannot be rotated.",
    });
  }

  await auditEvent({
    eventType: "api_key.rotated",
    outcome: "success",
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    request,
    metadata: { previousApiKeyId: id, newApiKeyId: rotated.id, prefix: rotated.key_prefix },
  });

  return v1JsonResponse(
    {
      id: rotated.id,
      name: rotated.name,
      prefix: rotated.key_prefix,
      scopes: rotated.scopes,
      expiresAt: rotated.expires_at,
      key: rotated.plaintext,
    },
    request,
    { status: 201 },
  );
}
