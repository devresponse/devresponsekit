import type { NextRequest } from "next/server";
import { requireApiPermission } from "@/lib/api-auth/v1-guard.server";
import { listApiKeysAdmin } from "@/lib/api-auth/api-keys.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/api-keys
 *
 * API-key governance listing (design §9.2, ADR-0001). Requires
 * `admin.apikeys.read`. SUPERADMIN sees every org; an ORG ADMIN sees only
 * their own org. Never returns secrets or hashes. Supports
 * `?page&pageSize&status&appUserId`.
 */
export async function GET(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.apikeys.read");
  if (!guard.ok) return guard.response;

  const sp = request.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize") ?? 25) || 25));
  const status = sp.get("status") ?? undefined;
  const appUserId = sp.get("appUserId") ?? undefined;

  // Org boundary: an org admin with no resolvable org sees nothing.
  const scope = resolveOrgScope(guard.grant.caller.access);
  if (!scope) return v1JsonResponse({ items: [], page, pageSize, total: 0 }, request);

  const { items, total } = await listApiKeysAdmin({
    limit: pageSize,
    offset: (page - 1) * pageSize,
    status: status === "active" || status === "revoked" ? status : undefined,
    appUserId,
    organizationId: scope.kind === "org" ? scope.organizationId : undefined,
  });

  return v1JsonResponse({ items, page, pageSize, total }, request);
}
