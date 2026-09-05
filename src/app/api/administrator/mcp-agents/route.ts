import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { buildListResponse } from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { listMcpAgents, parseMcpAgentListQuery } from "@/lib/mcp/agents.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/mcp-agents
 *
 * Lists self-registered MCP agents — OAuth clients whose service user holds
 * an `mcp` membership — org-scoped. Caller MUST hold `admin.clients.read`.
 * The cookie-session console counterpart to the machine
 * `/api/v1/admin/oauth-clients` surface.
 *
 * Paginated + filterable (review #13) on the standard list contract
 * (docs/admin-manager.md §5.1, parsed by `parseMcpAgentListQuery`):
 *   - `page` (≥1), `pageSize` (1–200, default 25)
 *   - `filter[status]` = `pending` | `active` | `revoked`
 *   - `sort` = `created_at.desc` (default) | `created_at.asc` | `name.asc|desc`
 * Pending agents always sort first. Response: `{ items, page, pageSize,
 * total, sort, pendingCount }` — `pendingCount` is scope-wide, not per page.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.clients.read");
  if (isAdminPermissionDenial(guard)) return guard.response;
  const query = parseMcpAgentListQuery(request.nextUrl.searchParams);
  // ADR-0001: a null scope (an org admin with no org) lists nothing. The
  // `listMcpAgents` query re-derives the same boundary; resolving it here keeps
  // the org gate visible in the route itself.
  if (!resolveOrgScope(guard.access)) {
    return NextResponse.json({ ...buildListResponse([], 0, query), pendingCount: 0 });
  }
  return NextResponse.json(await listMcpAgents(guard.access, query));
}
