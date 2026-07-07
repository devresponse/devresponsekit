import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { listMcpAgents } from "@/lib/mcp/agents.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/mcp-agents
 *
 * Lists self-registered MCP agents — OAuth clients whose service user holds
 * an `mcp` membership — org-scoped. Caller MUST hold `admin.clients.read`.
 * The cookie-session console counterpart to the machine
 * `/api/v1/admin/oauth-clients` surface.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.clients.read");
  if (isAdminPermissionDenial(guard)) return guard.response;
  // ADR-0001: a null scope (an org admin with no org) lists nothing. The
  // `listMcpAgents` query re-derives the same boundary; resolving it here keeps
  // the org gate visible in the route itself.
  if (!resolveOrgScope(guard.access)) return NextResponse.json({ items: [] });
  const items = await listMcpAgents(guard.access);
  return NextResponse.json({ items });
}
