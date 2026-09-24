import type { NextRequest } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQueryStrict,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { requireApiPermission } from "@/lib/api-auth/v1-guard.server";
import { V1_AUDIT_EVENTS_LIST } from "@/lib/api-auth/v1-list-contract";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";
import { withV1Route } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/audit-events
 *
 * Paginated read of the structured audit log (`admin.audit.read`). Reuses
 * the shared list-query contract, parsed strictly (F-34): `event_type` and
 * `outcome` may each repeat and match any of their values, and an unknown
 * outcome, filter or sort is a 400, as is a `q` (this list does not search,
 * and never did: it was ignored). Only a single value used to be honoured:
 * a repeated filter was dropped (every row), and the comma-joined form the
 * MCP gateway sent matched nothing, so "any denials or errors?" read as no.
 */
export const GET = withV1Route(async function GET(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.audit.read");
  if (!guard.ok) return guard.response;

  const parsed = parseListQueryStrict(request.nextUrl.searchParams, {
    allowedSortFields: V1_AUDIT_EVENTS_LIST.sortFields,
    search: V1_AUDIT_EVENTS_LIST.search,
    filters: V1_AUDIT_EVENTS_LIST.filters,
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });
  if (!parsed.ok) {
    return problemResponse("invalid_request", 400, request, {
      detail: parsed.detail,
      requestId: guard.grant.requestId,
    });
  }
  const { query } = parsed;

  // Org boundary (ADR-0001): an org admin sees only their org's audit
  // events (platform events with a null org are SUPERADMIN-only). A null
  // scope (org admin with no org) sees nothing.
  const scope = resolveOrgScope(guard.grant.caller.access);
  if (!scope) {
    return v1JsonResponse(buildListResponse([], 0, query), request);
  }

  let base = db.selectFrom("app_audit_events");
  if (scope.kind === "org") base = base.where("organization_id", "=", scope.organizationId);
  const eventTypes = query.filters.event_type;
  if (eventTypes) base = base.where("event_type", "in", eventTypes);
  const outcomes = query.filters.outcome;
  if (outcomes) base = base.where("outcome", "in", outcomes);

  const itemsQuery = applySortAndPagination(
    base.select([
      "id",
      "event_type",
      "outcome",
      "actor_better_auth_user_id",
      "app_user_id",
      "organization_id",
      "reason",
      "request_id",
      "created_at",
    ]),
    query,
  );

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  return v1JsonResponse(buildListResponse(items, total, query), request);
});
