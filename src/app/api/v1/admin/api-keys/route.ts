import type { NextRequest } from "next/server";
import { requireApiPermission } from "@/lib/api-auth/v1-guard.server";
import { listApiKeysAdmin } from "@/lib/api-auth/api-keys.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { offsetFor, parseListQueryStrict } from "@/lib/admin/list-query.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";
import { parseCredentialStatusParam, V1_CREDENTIAL_LIST } from "@/lib/api-auth/v1-list-contract";
import { withV1Route } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/api-keys
 *
 * API-key governance listing (design §5.4, §8.2; ADR-0001). Requires
 * `admin.apikeys.read`. SUPERADMIN sees every org; an ORG ADMIN sees only
 * their own org. Never returns secrets or hashes. Supports
 * `?page&pageSize&status&appUserId`, each at most once, and nothing else
 * from the shared list contract (no `sort`, `q` or `filter[…]`).
 */
export const GET = withV1Route(async function GET(request: NextRequest) {
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
  //
  // F-34: parsed strictly. This listing takes no `sort`, `q` or `filter[…]`,
  // and the lenient parser dropped them, so `filter[status]=revoked` (the
  // form `/users` uses) listed every key; each is now a 400, as is an
  // unknown or repeated `status` or a repeated `appUserId`.
  const parsed = parseListQueryStrict(sp, {
    allowedSortFields: V1_CREDENTIAL_LIST.sortFields,
    search: V1_CREDENTIAL_LIST.search,
    filters: V1_CREDENTIAL_LIST.filters,
    maxPageSize: 200,
    defaultPageSize: 25,
  });
  if (!parsed.ok) {
    return problemResponse("invalid_request", 400, request, {
      requestId: guard.grant.requestId,
      detail: parsed.detail,
    });
  }
  const { query } = parsed;
  const { page, pageSize } = query;
  const status = parseCredentialStatusParam(sp);
  if (!status.ok) {
    return problemResponse("invalid_request", 400, request, {
      requestId: guard.grant.requestId,
      detail: status.detail,
    });
  }
  const appUserIds = sp.getAll("appUserId");
  if (appUserIds.length > 1) {
    return problemResponse("invalid_request", 400, request, {
      requestId: guard.grant.requestId,
      detail: "`appUserId` is a single UUID and cannot be repeated.",
    });
  }
  const appUserId = appUserIds[0];
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
    status: status.status,
    appUserId,
    organizationId: scope.kind === "org" ? scope.organizationId : undefined,
  });

  return v1JsonResponse({ items, page, pageSize, total }, request);
});
