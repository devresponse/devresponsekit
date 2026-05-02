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
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/roles/[id]/members
 *
 * Paginated grid feed of users carrying the role, joined with
 * `app_users` and the user's organization membership for the role's
 * org context (per Phase 4 spec). Caller MUST hold `admin.roles.read`.
 *
 * `q` matches case-insensitively against `app_users.primary_email` and
 * `display_name` so the role-detail Members tab can search a large
 * member set without round-tripping to the parent grid.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const roleExists = await db
    .selectFrom("app_roles")
    .select(["id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!roleExists) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["primary_email", "display_name", "created_at"],
    defaultSort: [{ field: "primary_email", direction: "asc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_users as u", "u.id", "ur.app_user_id")
    .leftJoin("app_organizations as o", "o.id", "ur.organization_id")
    .where("ur.role_id", "=", id);

  if (query.q) {
    const like = `%${query.q}%`;
    base = base.where((eb) =>
      eb.or([eb("u.primary_email", "ilike", like), eb("u.display_name", "ilike", like)]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "u.id as app_user_id",
      "u.primary_email as primary_email",
      "u.display_name as display_name",
      "u.status as status",
      "ur.organization_id as organization_id",
      "o.name as organization_name",
      "ur.created_at as created_at",
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
