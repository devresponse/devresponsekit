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
 * GET /api/administrator/users/:id/roles
 *
 * Paginated list of the application ROLE ASSIGNMENTS (`app_user_roles`) a
 * specific user holds, joined to the role and the organization the role was
 * assigned in. Read-only — role assignment/removal lives on the role's own
 * members editor.
 *
 * ADR-0001: an ORG ADMIN sees only this user's assignments in their own org;
 * a SUPERADMIN sees every org. The target user is itself already org-scoped by
 * `resolveTargetUser` (an org admin cannot resolve a user outside their org),
 * and the assignment query is scoped again here so a shared user's foreign-org
 * roles never leak.
 *
 * Caller MUST hold `admin.users.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["role_name", "role_key", "organization_name", "created_at"],
    allowedFilters: ["organization_id"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_roles as r", "r.id", "ur.role_id")
    .innerJoin("app_organizations as o", "o.id", "ur.organization_id")
    .where("ur.app_user_id", "=", target.appUserId);

  // ADR-0001: an org admin sees only this user's role assignments in their own
  // org, never the user's footprint in other tenants. SUPERADMIN: all.
  const scope = resolveOrgScope(guard.access);
  if (scope?.kind === "org") {
    base = base.where("ur.organization_id", "=", scope.organizationId);
  }

  const orgIdFilter = query.filters.organization_id;
  if (typeof orgIdFilter === "string" && orgIdFilter.length > 0) {
    base = base.where("ur.organization_id", "=", orgIdFilter);
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      // `app_user_roles` has a composite PK (app_user_id, organization_id,
      // role_id) and no surrogate id — synthesize a stable per-row key so the
      // client grid can identify rows.
      sql<string>`ur.organization_id::text || ':' || ur.role_id::text`.as("id"),
      "ur.role_id",
      "r.key as role_key",
      "r.name as role_name",
      "r.description as role_description",
      "ur.organization_id",
      "o.slug as organization_slug",
      "o.name as organization_name",
      "ur.created_at as created_at",
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
