import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { getApiKeyById, revokeApiKey } from "@/lib/api-auth/api-keys.server";
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
 * DELETE /api/v1/me/api-keys/[id]
 *
 * Revokes one of the CALLER'S OWN keys (design §9.1). Ownership is
 * re-checked against the session principal — a caller can never revoke
 * another user's key. Idempotent.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAccountUser(request, "account.apikeys.manage");
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
  // 404 (not 403) when the key isn't the caller's own, so we don't leak
  // the existence of other users' key ids.
  if (!key || key.app_user_id !== actor.appUserId) {
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
}
