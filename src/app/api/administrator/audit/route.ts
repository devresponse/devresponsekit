import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  filterValues,
  parseListQuery,
  type FilterValue,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * Returns true when the value is a parsed range filter (`from` / `to`).
 * Range filters are produced by `parseListQuery` for `filter[name][from]`
 * / `filter[name][to]` query-string syntax (§7).
 */
function isRangeFilter(value: FilterValue | undefined): value is { from?: string; to?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("from" in value || "to" in value)
  );
}

/**
 * Parses an ISO-8601 date-time string. Returns `null` for empty / invalid
 * values so the handler can ignore the bound rather than producing a 500.
 */
function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GET /api/administrator/audit
 *
 * Read-only paginated view of `app_audit_events` (docs/admin-manager.md
 * §8.10). Supports the standard `ListResponse` envelope plus the audit-
 * explorer filters. Each exact-match filter may repeat and matches any of
 * its values (F-74):
 *
 *   - `filter[event_type]` — exact event type
 *   - `filter[outcome]`    — `success` | `failure` | `denied`
 *   - `filter[actor]`      — Better Auth actor user id (text)
 *   - `filter[app_user_id]`            — UUID (anything else is a 400, F-63)
 *   - `filter[organization_id]`        — UUID (likewise)
 *   - `filter[target_application_id]`  — text
 *   - `filter[created_at][from|to]`    — ISO-8601 range
 *
 * `q` matches case-insensitively against `event_type`, `email`, and
 * `reason`.
 *
 * Caller MUST hold `admin.audit.read`. The endpoint never returns
 * secret material — only the columns explicitly selected below are
 * surfaced.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.audit.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["created_at", "event_type", "outcome", "actor_better_auth_user_id"],
    allowedFilters: [
      "event_type",
      "outcome",
      "actor",
      "app_user_id",
      "organization_id",
      "target_application_id",
      "created_at",
    ],
    uuidFilters: { app_user_id: [], organization_id: [] },
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  // Org boundary (ADR-0001): an org admin sees only their org's audit
  // events (platform events with a null org are SUPERADMIN-only).
  const scope = resolveOrgScope(guard.access);
  if (!scope) return NextResponse.json(buildListResponse([], 0, query));

  let base = db.selectFrom("app_audit_events as e");

  if (scope.kind === "org") {
    base = base.where("e.organization_id", "=", scope.organizationId);
  }

  // Each filter matches any of its values (F-74). A repeated one used to be
  // dropped, so `filter[event_type]=a&filter[event_type]=b` read the whole log.
  const eventTypes = filterValues(query, "event_type");
  if (eventTypes.length > 0) base = base.where("e.event_type", "in", eventTypes);

  const outcomes = filterValues(query, "outcome");
  if (outcomes.length > 0) base = base.where("e.outcome", "in", outcomes);

  const actors = filterValues(query, "actor");
  if (actors.length > 0) base = base.where("e.actor_better_auth_user_id", "in", actors);

  const appUserIds = filterValues(query, "app_user_id");
  if (appUserIds.length > 0) base = base.where("e.app_user_id", "in", appUserIds);

  const organizationIds = filterValues(query, "organization_id");
  if (organizationIds.length > 0) base = base.where("e.organization_id", "in", organizationIds);

  const targetApps = filterValues(query, "target_application_id");
  if (targetApps.length > 0) base = base.where("e.target_application_id", "in", targetApps);

  const createdAt = query.filters.created_at;
  if (isRangeFilter(createdAt)) {
    const from = parseIsoDate(createdAt.from);
    const to = parseIsoDate(createdAt.to);
    if (from) base = base.where("e.created_at", ">=", from);
    if (to) base = base.where("e.created_at", "<=", to);
  }

  if (query.q) {
    const like = likeContains(query.q);
    base = base.where((eb) =>
      eb.or([
        eb("e.event_type", "ilike", like),
        eb("e.email", "ilike", like),
        eb("e.reason", "ilike", like),
      ]),
    );
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
});
