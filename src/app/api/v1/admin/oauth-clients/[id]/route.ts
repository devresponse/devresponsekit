import type { NextRequest } from "next/server";
import { z } from "zod";
import { auditEvent } from "@/lib/audit.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import {
  getOauthClientById,
  revokeOauthClient,
  updateOauthClient,
} from "@/lib/api-auth/oauth-clients.server";
import { normalizeScopes, ungrantableScopesForCaller } from "@/lib/api-auth/scopes";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/oauth-clients/[id] — read one (`admin.clients.read`). */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiPermission(request, "admin.clients.read");
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);
  const client = await getOauthClientById(id);
  if (!client) return problemResponse("not_found", 404, request);
  return v1JsonResponse({ client }, request);
}

/** PATCH /api/v1/admin/oauth-clients/[id] — edit name/scopes (`admin.clients.manage`). */
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    scopes: z.array(z.string().min(1).max(120)).max(64).optional(),
  })
  .strict();

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiPermission(request, "admin.clients.manage");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.admin.clients", grant, request);
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);
  const client = await getOauthClientById(id);
  if (!client) return problemResponse("not_found", 404, request);

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }

  const scopes = parsed.data.scopes ? normalizeScopes(parsed.data.scopes) : undefined;
  if (scopes) {
    const ungrantable = ungrantableScopesForCaller(
      grant.caller.access.permissions,
      grant.caller.grantedScopes,
      scopes,
    );
    if (ungrantable.length > 0) {
      return problemResponse("invalid_scope", 403, request, {
        extra: { ungrantableScopes: ungrantable },
        requestId: grant.requestId,
      });
    }
  }

  const updated = await updateOauthClient(id, { name: parsed.data.name, scopes });
  if (!updated) {
    return problemResponse("conflict", 409, request, {
      detail: "No changes, or the client is not active.",
      requestId: grant.requestId,
    });
  }

  await auditEvent({
    eventType: "oauth_client.updated",
    outcome: "success",
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: client.app_user_id,
    request,
    requestId: grant.requestId,
    metadata: { clientRowId: id, fields: Object.keys(parsed.data) },
  });

  return v1JsonResponse({ ok: true, id }, request, { requestId: grant.requestId });
}

/** DELETE /api/v1/admin/oauth-clients/[id] — revoke (`admin.clients.manage`). */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiPermission(request, "admin.clients.manage");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.admin.clients", grant, request);
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);
  const client = await getOauthClientById(id);
  if (!client) return problemResponse("not_found", 404, request);

  const revokerAppUserId = grant.caller.access.appUserId ?? client.app_user_id;
  const revoked = await revokeOauthClient(id, revokerAppUserId);

  await auditEvent({
    eventType: "oauth_client.revoked",
    outcome: "success",
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: client.app_user_id,
    request,
    requestId: grant.requestId,
    metadata: { clientRowId: id, alreadyRevoked: !revoked },
  });

  return v1JsonResponse({ ok: true, id, revoked }, request, { requestId: grant.requestId });
}
