import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { isWithinTenant, requireApiAccount, tenantConfinement } from "@/lib/account/guard.server";
import { getApiKeyById, revokeApiKey } from "@/lib/api-auth/api-keys.server";
import {
  consumeToken,
  rateLimitKey,
  DEFAULT_ADMIN_MUTATION_LIMIT,
} from "@/lib/admin/rate-limit.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";
import { withV1Route } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/v1/me/api-keys/[id]
 *
 * Revokes one of the CALLER'S OWN keys (design §5.3, §5.4). Ownership is
 * re-checked against the session principal — a caller can never revoke
 * another user's key. Idempotent.
 *
 * An IMPERSONATED session is refused (403) by the account guard's default
 * (IMP-1): while impersonating, the ownership check above passes for every key
 * the borrowed user holds in ANY tenant, so this would let an administrator
 * destroy another person's credentials from inside their own account.
 *
 * F-01 — a BEARER caller only reaches keys in the org it acts in
 * ({@link tenantConfinement}); a key elsewhere answers the same 404 as a key
 * that is not the caller's, so a credential bound to one tenant can neither
 * revoke nor probe the owner's keys in another.
 */
export const DELETE = withV1Route(async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiAccount(request, "account.apikeys.manage");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  // Throttle credential revoke per principal (sec-2).
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
  // 404 (not 403) when the key isn't the caller's own, or lies outside the
  // caller's tenant, so we don't leak the existence of those key ids.
  if (
    !key ||
    key.app_user_id !== actor.appUserId ||
    !isWithinTenant(key.organization_id, tenantConfinement(actor))
  ) {
    return problemResponse("not_found", 404, request);
  }

  const revoked = await revokeApiKey(id, actor.appUserId, "self_revoked");

  await auditEvent({
    eventType: "api_key.revoked",
    outcome: "success",
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    request,
    metadata: { apiKeyId: id, alreadyRevoked: !revoked },
  });

  return v1JsonResponse({ ok: true, id, revoked }, request);
});
