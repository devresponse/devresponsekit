import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { createOrganizationSchema } from "@/lib/validation/organizations";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { hasCrossOrgReach, resolveOrgScope } from "@/lib/admin/access-scope.server";
import { moveDefaultOrganizationFlag } from "@/lib/default-organization.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/organizations
 *
 * Paginated list of `app_organizations` rows with member counts.
 * Returns the uniform `ListResponse` envelope from §5.1.
 *
 * Filters:
 *   - `status` — organization status string
 *   - `is_default` — `"true"` or `"false"`
 *
 * `q` matches case-insensitively against `slug` and `name`.
 *
 * Caller MUST hold `admin.orgs.read`.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["slug", "name", "status", "created_at", "is_default", "member_count"],
    allowedFilters: ["status", "is_default"],
    defaultSort: [{ field: "slug", direction: "asc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  // Org boundary (ADR-0001): an org admin sees only their own org row;
  // superadmin sees every org. Null scope → none.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return NextResponse.json(buildListResponse([], 0, query));

  let base = db.selectFrom("app_organizations as o");

  if (scope.kind === "org") {
    base = base.where("o.id", "=", scope.organizationId);
  }

  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    base = base.where("o.status", "=", statusFilter);
  }

  const isDefaultFilter = query.filters.is_default;
  if (isDefaultFilter === "true") {
    base = base.where("o.is_default", "=", true);
  } else if (isDefaultFilter === "false") {
    base = base.where("o.is_default", "=", false);
  }

  if (query.q) {
    const like = likeContains(query.q);
    base = base.where((eb) => eb.or([eb("o.slug", "ilike", like), eb("o.name", "ilike", like)]));
  }

  // Precompute member_count as a GROUPed derived table + LEFT JOIN, instead
  // of a correlated scalar sub-select (P2-17). With the sub-select aliased as
  // a sort field, `ORDER BY member_count` forces Postgres to evaluate the
  // count for EVERY matching org, sort the whole set, then LIMIT. The grouped
  // join lets the planner hash-aggregate `app_organization_memberships` once.
  // The derived table is unique on `organization_id`, so the join stays 1:1
  // and the `count(*)` total (computed below on the join-free `base`) is
  // unchanged.
  const withCounts = base.leftJoin(
    (eb) =>
      eb
        .selectFrom("app_organization_memberships")
        .select(["organization_id", sql<string>`count(*)`.as("c")])
        .groupBy("organization_id")
        .as("mc"),
    (join) => join.onRef("mc.organization_id", "=", "o.id"),
  );

  const itemsQuery = applySortAndPagination(
    withCounts.select([
      "o.id",
      "o.slug",
      "o.name",
      "o.status",
      "o.is_default",
      "o.created_at",
      sql<string>`coalesce(${sql.ref("mc.c")}, 0)`.as("member_count"),
    ]),
    query,
  );

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  const normalised = items.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    is_default: row.is_default,
    created_at: row.created_at,
    member_count: Number(row.member_count ?? 0),
  }));

  return NextResponse.json(buildListResponse(normalised, total, query));
});

/**
 * POST /api/administrator/organizations
 *
 * Creates a new organization. Caller MUST hold `admin.orgs.create`.
 *
 * If `isDefault: true`, the new org is inserted and then made THE default in
 * the same transaction (`moveDefaultOrganizationFlag`, F-40): the flag is
 * cleared on the previous default under the default-flag lock, and new
 * unmapped sign-ups land in the new org from then on.
 */

export const POST = withAdminRoute(async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.orgs.create");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.create",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  // ADR-0001: creating a new tenant is a SUPERADMIN-only action; an org
  // admin manages only their existing org.
  // MACHINE-2: `hasCrossOrgReach`, not `isSuperadmin` — an ORG-BOUND bearer
  // credential never takes the SUPERADMIN bypass on a platform-wide action,
  // even when its owner is a global superuser.
  if (!hasCrossOrgReach(guard.access)) {
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = createOrganizationSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;
  const setDefault = input.isDefault === true;

  let inserted: { id: string; slug: string };
  let previousDefaultOrganizationIds: string[] = [];
  try {
    if (setDefault) {
      inserted = await db.transaction().execute(async (trx) => {
        // Inserted as non-default, then MOVED onto it: the one helper that
        // sets the flag takes the lock that keeps concurrent moves from
        // leaving two defaults (F-40).
        const row = await trx
          .insertInto("app_organizations")
          .values({
            slug: input.slug,
            name: input.name,
            is_default: false,
          })
          .returning(["id", "slug"])
          .executeTakeFirstOrThrow();
        previousDefaultOrganizationIds = (await moveDefaultOrganizationFlag(trx, row.id)) ?? [];
        return row;
      });
    } else {
      inserted = await db
        .insertInto("app_organizations")
        .values({
          slug: input.slug,
          name: input.name,
          is_default: false,
        })
        .returning(["id", "slug"])
        .executeTakeFirstOrThrow();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("slug_taken", 409, request);
    }
    throw err;
  }

  await auditOrgAction("admin.organization.created", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: inserted.id,
    metadata: {
      organizationId: inserted.id,
      slug: inserted.slug,
      ...(setDefault ? { isDefault: true } : {}),
      // F-40: the org(s) that lost the default flag to the new one.
      ...(previousDefaultOrganizationIds.length > 0 ? { previousDefaultOrganizationIds } : {}),
    },
  });

  return NextResponse.json({ ok: true, id: inserted.id, slug: inserted.slug }, { status: 201 });
});
