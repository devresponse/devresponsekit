import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { createOrganizationSchema } from "@/lib/validation/organizations";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isSuperadmin, resolveOrgScope } from "@/lib/admin/access-scope.server";

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
export async function GET(request: NextRequest) {
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
    const like = `%${query.q}%`;
    base = base.where((eb) => eb.or([eb("o.slug", "ilike", like), eb("o.name", "ilike", like)]));
  }

  const itemsQuery = applySortAndPagination(
    base.select((eb) => [
      "o.id",
      "o.slug",
      "o.name",
      "o.status",
      "o.is_default",
      "o.created_at",
      eb
        .selectFrom("app_organization_memberships as m")
        .select(sql<string>`count(*)`.as("c"))
        .whereRef("m.organization_id", "=", "o.id")
        .as("member_count"),
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
}

/**
 * POST /api/administrator/organizations
 *
 * Creates a new organization. Caller MUST hold `admin.orgs.create`.
 *
 * If `isDefault: true`, in a single transaction we first clear the
 * existing default then insert with `is_default = true`.
 */

export async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.orgs.create");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.create",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  // ADR-0001: creating a new tenant is a SUPERADMIN-only action; an org
  // admin manages only their existing org.
  if (!isSuperadmin(guard.access)) {
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
  try {
    if (setDefault) {
      inserted = await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("app_organizations")
          .set({ is_default: false })
          .where("is_default", "=", true)
          .execute();
        return await trx
          .insertInto("app_organizations")
          .values({
            slug: input.slug,
            name: input.name,
            is_default: true,
          })
          .returning(["id", "slug"])
          .executeTakeFirstOrThrow();
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
    metadata: { organizationId: inserted.id, slug: inserted.slug },
  });

  return NextResponse.json({ ok: true, id: inserted.id, slug: inserted.slug }, { status: 201 });
}
