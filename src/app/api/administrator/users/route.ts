import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import {
  isAdminPermissionDenial,
  requireAdminPermission,
} from "@/lib/admin/permissions.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/users
 *
 * Paginated list of `app_users` rows for the Administrator workspace.
 * Returns the uniform `ListResponse` envelope documented in
 * docs/admin-manager.md §5.1.
 *
 * Threat / contract:
 *   - Caller MUST hold `admin.users.read`. Without it the endpoint
 *     returns 403 and writes a `denied` audit row.
 *   - Filters and sort fields are allow-listed; unknown values are
 *     silently dropped, so attackers can't pivot to unindexed columns.
 *   - The `q` global search is bound via Kysely parameters (no string
 *     concatenation) and matched case-insensitively against
 *     `primary_email` and `display_name`.
 *
 * Joining with the Better Auth `user` table is intentionally out of
 * scope for this endpoint per plan §13 — that join happens in the
 * higher-level Phase-3 endpoints once we need the auth `banned` /
 * `role` columns. Here we ship the application view only, which keeps
 * the endpoint cheap and indexable.
 */
const ALLOWED_STATUS = new Set([
  "active",
  "pending_approval",
  "blocked",
  "suspended",
  "deactivated",
]);

export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.users.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["created_at", "primary_email", "display_name", "status"],
    allowedFilters: ["status"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  // Build the base query with all WHERE clauses applied. We then derive
  // both the count and the page from the same builder so a future filter
  // automatically applies to both.
  let base = db.selectFrom("app_users");

  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && ALLOWED_STATUS.has(statusFilter)) {
    base = base.where("status", "=", statusFilter);
  } else if (Array.isArray(statusFilter)) {
    const cleaned = statusFilter.filter((v) => ALLOWED_STATUS.has(v));
    if (cleaned.length > 0) base = base.where("status", "in", cleaned);
  }

  if (query.q) {
    const like = `%${query.q}%`;
    base = base.where((eb) =>
      eb.or([
        eb("primary_email", "ilike", like),
        eb("display_name", "ilike", like),
      ]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base
      .select([
        "id",
        "better_auth_user_id",
        "primary_email",
        "display_name",
        "status",
        "preferred_locale",
        "created_at",
        "updated_at",
      ]),
    query,
  );

  const [items, totalRow] = await Promise.all([
    itemsQuery.execute(),
    base.select(sql<string>`count(*)`.as("total")).executeTakeFirst(),
  ]);

  const total = Number(totalRow?.total ?? 0);

  return NextResponse.json(buildListResponse(items, total, query));
}
