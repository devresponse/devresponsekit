import type { NextRequest } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import { requireApiPermission } from "@/lib/api-auth/v1-guard.server";
import { v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/audit-events
 *
 * Paginated read of the structured audit log (`admin.audit.read`). Reuses
 * the shared list-query contract; filters on `event_type` and `outcome`.
 */
export async function GET(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.audit.read");
  if (!guard.ok) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["created_at", "event_type", "outcome"],
    allowedFilters: ["event_type", "outcome"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db.selectFrom("app_audit_events");
  const eventType = query.filters.event_type;
  if (typeof eventType === "string") base = base.where("event_type", "=", eventType);
  const outcome = query.filters.outcome;
  if (typeof outcome === "string") base = base.where("outcome", "=", outcome);

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

  const [items, totalRow] = await Promise.all([
    itemsQuery.execute(),
    base.select(sql<string>`count(*)`.as("total")).executeTakeFirst(),
  ]);

  return v1JsonResponse(buildListResponse(items, Number(totalRow?.total ?? 0), query), request);
}
