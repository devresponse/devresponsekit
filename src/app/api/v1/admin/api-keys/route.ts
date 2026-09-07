import type { NextRequest } from "next/server";
import { requireApiPermission } from "@/lib/api-auth/v1-guard.server";
import { listApiKeysAdmin } from "@/lib/api-auth/api-keys.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { offsetFor, parseListQuery } from "@/lib/admin/list-query.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/api-keys
 *
 * API-key governance listing (design §5.4, §8.2; ADR-0001). Requires
 * `admin.apikeys.read`. SUPERADMIN sees every org; an ORG ADMIN sees only
 * their own org. Never returns secrets or hashes. Supports
 * `?page&pageSize&status&appUserId`.
 */
export async function GET(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.apikeys.read");
  if (!guard.ok) return guard.response;

  const sp = request.nextUrl.searchParams;
  // review #47: the hand-rolled `Number(...) || 1` parsing let a fractional or
  // out-of-range `page` (`1.5`, `1e400`) through as a non-integer OFFSET and a
  // non-UUID `appUserId` straight into a `uuid` comparison — Postgres answers
  // 22P02 and the caller sees a 500 for what is plainly a bad request. Page
  // and pageSize now go through the repo's shared list-query parser (integer
  // parse + clamp, identical to every other list endpoint); the id is
  // validated against the `uuid` format the OpenAPI document already declares
  // and rejected with a 400 problem rather than reaching the database.
  const query = parseListQuery(sp, {
    allowedSortFields: [],
    maxPageSize: 200,
    defaultPageSize: 25,
  });
  const { page, pageSize } = query;
  const status = sp.get("status") ?? undefined;
  const appUserId = sp.get("appUserId") ?? undefined;
  if (appUserId !== undefined && !isUuid(appUserId)) {
    return problemResponse("invalid_request", 400, request, {
      requestId: guard.grant.requestId,
      detail: "`appUserId` must be a UUID.",
    });
  }

  // Org boundary: an org admin with no resolvable org sees nothing.
  const scope = resolveOrgScope(guard.grant.caller.access);
  if (!scope) return v1JsonResponse({ items: [], page, pageSize, total: 0 }, request);

  const { items, total } = await listApiKeysAdmin({
    limit: pageSize,
    offset: offsetFor(query),
    status: status === "active" || status === "revoked" ? status : undefined,
    appUserId,
    organizationId: scope.kind === "org" ? scope.organizationId : undefined,
  });

  return v1JsonResponse({ items, page, pageSize, total }, request);
}
