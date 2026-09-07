import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { activateMcpAgent, getMcpAgent } from "@/lib/mcp/agents.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/administrator/mcp-agents/:id/approve
 *
 * Activates a pending agent's service account (its `app_users` row + `mcp`
 * membership), so it can begin minting tokens. Caller MUST hold
 * `admin.clients.manage`. Idempotent — an already-active agent returns
 * `{ ok: true, activated: false }`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
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

  // Approving a REVOKED agent used to activate its service account: the
  // client stayed dead, but the machine principal came back to life (and the
  // console filed it under "Active" again). A revoked client is terminal —
  // refuse the transition (review #56).
  if (agent.clientStatus !== "active") {
    return adminErrorResponse("agent_inactive", 409, request, { requestId: guard.requestId });
  }

  const activated = await activateMcpAgent(agent.appUserId);
  if (activated) {
    await auditEvent({
      eventType: "admin.mcp_agent.approved",
      outcome: "success",
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: agent.appUserId,
      organizationId: agent.organizationId,
      request,
      requestId: guard.requestId,
      metadata: { clientId: id },
    });
  }
  return NextResponse.json({ ok: true, activated });
}
