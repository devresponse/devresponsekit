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
 * GET /api/administrator/memberships
 *
 * Cross-org search for memberships with joins to both user and org.
 * Filters:
 *   - status — membership status
 *   - organization_id — filter to a specific org
 *   - source_provider — filter by source provider
 *
 * `q` searches case-insensitively against app_users.display_name
 * and app_organizations.slug/name.
 *
 * Caller MUST hold `admin.orgs.read`.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: [
      "status",
      "created_at",
      "user_display_name",
      "organization_slug",
      "source_provider",
    ],
    allowedFilters: ["status", "organization_id", "source_provider"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_users as u", "u.id", "m.app_user_id")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id");

  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    base = base.where("m.status", "=", statusFilter);
  }

  const orgIdFilter = query.filters.organization_id;
  if (typeof orgIdFilter === "string" && orgIdFilter.length > 0) {
    base = base.where("m.organization_id", "=", orgIdFilter);
  }

  const providerFilter = query.filters.source_provider;
  if (typeof providerFilter === "string" && providerFilter.length > 0) {
    base = base.where("m.source_provider", "=", providerFilter);
  }

  if (query.q) {
    const like = `%${query.q}%`;
    base = base.where((eb) =>
      eb.or([
        eb("u.display_name", "ilike", like),
        eb("o.slug", "ilike", like),
        eb("o.name", "ilike", like),
      ]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "m.id",
      "m.organization_id",
      "o.slug as organization_slug",
      "o.name as organization_name",
      "m.app_user_id",
      "u.display_name as user_display_name",
      "m.status",
      "m.source_provider",
      "m.provider_organization_key",
      "m.created_at",
      "m.updated_at",
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
