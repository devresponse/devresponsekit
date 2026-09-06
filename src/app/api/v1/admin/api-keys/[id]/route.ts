import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { getApiKeyById, revokeApiKey } from "@/lib/api-auth/api-keys.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/v1/admin/api-keys/[id]
 *
 * Revokes ANY user's API key (design §5.3, §8.2). Requires
 * `admin.apikeys.manage`. The acting admin's app-user id is recorded as
 * the revoker. Idempotent; rate-limited per credential.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiPermission(request, "admin.apikeys.manage");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.admin.apikeys", grant, request);
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);

  const key = await getApiKeyById(id);
  // ADR-0001: an org admin may only revoke keys in their own org. A 404
  // (not 403) on another org's key avoids leaking its existence.
  if (!key || !canAccessOrg(grant.caller.access, key.organization_id)) {
    return problemResponse("not_found", 404, request);
  }

  const revokerAppUserId = grant.caller.access.appUserId ?? key.app_user_id;
  const revoked = await revokeApiKey(id, revokerAppUserId, "admin_revoked");

  await auditEvent({
    eventType: "api_key.revoked",
    outcome: "success",
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: key.app_user_id,
    request,
    requestId: grant.requestId,
    metadata: { apiKeyId: id, byAdmin: true, alreadyRevoked: !revoked },
  });

  return v1JsonResponse({ ok: true, id, revoked }, request, { requestId: grant.requestId });
}
