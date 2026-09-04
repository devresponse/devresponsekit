import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditEvent } from "@/lib/audit.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { revokeOauthClient, updateOauthClient } from "@/lib/api-auth/oauth-clients.server";
import { normalizeScopes, ungrantableScopesForCaller } from "@/lib/api-auth/scopes";
import { getMcpAgent } from "@/lib/mcp/agents.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchSchema = z.object({ scopes: z.array(z.string()).max(64) }).strict();

/**
 * PATCH /api/administrator/mcp-agents/:id
 *
 * Sets the agent client's **scope ceiling**. Caller MUST hold
 * `admin.clients.manage`. The scopes take effect only where the service
 * account also holds the matching permission (effective = scope ∩
 * permission) — grant the service user a role via the Users console to make
 * a granted scope usable.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.clients.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.mcp_agents.manage",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request, { requestId: guard.requestId });
  }
  const agent = await getMcpAgent(guard.access, id);
  if (!agent || !canAccessOrg(guard.access, agent.organizationId)) {
    return adminErrorResponse("not_found", 404, request, { requestId: guard.requestId });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request, { requestId: guard.requestId });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request, { requestId: guard.requestId });
  }

  const scopes = normalizeScopes(parsed.data.scopes);
  // A cookie admin carries full authority (null granted scopes) and may
  // grant any scope their own permissions cover. A bearer caller (API key /
  // JWT / agent token) is additionally bounded by its own granted scopes —
  // a credential can never mint a broader one (design §7; review #12).
  const ungrantable = ungrantableScopesForCaller(
    guard.access.permissions,
    guard.grantedScopes,
    scopes,
  );
  if (ungrantable.length > 0) {
    return adminErrorResponse("invalid_scope", 422, request, {
      requestId: guard.requestId,
      extra: { ungrantableScopes: ungrantable },
    });
  }

  await updateOauthClient(id, { scopes });
  await auditEvent({
    eventType: "admin.mcp_agent.scopes_updated",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: agent.appUserId,
    organizationId: agent.organizationId,
    request,
    requestId: guard.requestId,
    metadata: { clientId: id, scopes },
  });
  return NextResponse.json({ ok: true, scopes });
}

/**
 * DELETE /api/administrator/mcp-agents/:id
 *
 * Revokes the agent's OAuth client (idempotent). Caller MUST hold
 * `admin.clients.manage`. The service account is left intact for the audit
 * trail; revoking the client immediately stops it minting or using tokens.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.clients.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.mcp_agents.manage",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const actorAppUserId = guard.access.appUserId;
  if (!actorAppUserId) {
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request, { requestId: guard.requestId });
  }
  const agent = await getMcpAgent(guard.access, id);
  if (!agent || !canAccessOrg(guard.access, agent.organizationId)) {
    return adminErrorResponse("not_found", 404, request, { requestId: guard.requestId });
  }
  if (agent.clientStatus !== "active") {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await revokeOauthClient(id, actorAppUserId);
  await auditEvent({
    eventType: "admin.mcp_agent.revoked",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: agent.appUserId,
    organizationId: agent.organizationId,
    request,
    requestId: guard.requestId,
    metadata: { clientId: id },
  });
  return NextResponse.json({ ok: true });
}
