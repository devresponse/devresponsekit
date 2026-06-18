import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/users/:id/audit
 *
 * Read-only paginated audit trail for a specific user — the `app_audit_events`
 * rows whose `app_user_id` is this user (events ABOUT the user). Selects the
 * same columns as the global audit explorer so the shared audit grid renders
 * it unchanged. Optional `event_type` / `outcome` filters.
 *
 * ADR-0001: org-scoped — an org admin sees only events in their own org (and
 * can only resolve a target user in their org); a SUPERADMIN sees every org,
 * including platform events with a null org for this user.
 *
 * Caller MUST hold `admin.audit.read` — a stricter gate than the page's own
 * `admin.users.read`, since audit rows are more sensitive than the user record.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.audit.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["created_at", "event_type", "outcome"],
    allowedFilters: ["event_type", "outcome"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  // Org boundary (ADR-0001): an org admin sees only their org's events;
  // platform events with a null org are SUPERADMIN-only.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return NextResponse.json(buildListResponse([], 0, query));

  let base = db.selectFrom("app_audit_events as e").where("e.app_user_id", "=", target.appUserId);

  if (scope.kind === "org") {
    base = base.where("e.organization_id", "=", scope.organizationId);
  }

  const eventTypeFilter = query.filters.event_type;
  if (typeof eventTypeFilter === "string" && eventTypeFilter.length > 0) {
    base = base.where("e.event_type", "=", eventTypeFilter);
  }

  const outcomeFilter = query.filters.outcome;
  if (typeof outcomeFilter === "string" && outcomeFilter.length > 0) {
    base = base.where("e.outcome", "=", outcomeFilter);
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "e.id",
      "e.event_type",
      "e.outcome",
      "e.actor_better_auth_user_id",
      "e.app_user_id",
      "e.organization_id",
      "e.target_application_id",
      "e.provider",
      "e.email",
      "e.ip_address",
      "e.user_agent",
      "e.reason",
      "e.metadata",
      "e.created_at",
    ]),
    query,
  );

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  return NextResponse.json(buildListResponse(items, total, query));
}
