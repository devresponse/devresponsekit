import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
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
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAccountUser(request, "account.apikeys.manage");
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
  if (!key || key.app_user_id !== actor.appUserId) {
    return problemResponse("not_found", 404, request);
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
