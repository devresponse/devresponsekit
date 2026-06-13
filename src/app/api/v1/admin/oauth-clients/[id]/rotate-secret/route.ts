import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { getOauthClientById, rotateOauthClientSecret } from "@/lib/api-auth/oauth-clients.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/admin/oauth-clients/[id]/rotate-secret
 *
 * Issues a new client secret in place (`admin.clients.manage`). The new
 * secret is returned ONCE; the old one stops working immediately.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiPermission(request, "admin.clients.manage");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.admin.clients", grant, request);
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);
  const client = await getOauthClientById(id);
  if (!client) return problemResponse("not_found", 404, request);

  const secret = await rotateOauthClientSecret(id);
  if (!secret) {
    return problemResponse("conflict", 409, request, {
      detail: "Client is not active.",
      requestId: grant.requestId,
    });
  }

  await auditEvent({
    eventType: "oauth_client.secret_rotated",
    outcome: "success",
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: client.app_user_id,
    request,
    requestId: grant.requestId,
    metadata: { clientRowId: id },
  });

  return v1JsonResponse({ id, clientId: client.client_id, clientSecret: secret }, request, {
    requestId: grant.requestId,
  });
}
