import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { createRoleSchema } from "@/lib/validation/roles";
import { db } from "@/db/database";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
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
import { canAccessOrg, isSuperadmin, resolveOrgScope } from "@/lib/admin/access-scope.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/roles
 *
 * Paginated list of `app_roles` rows with permission/member counts.
 * Returns the uniform `ListResponse` envelope from §5.1.
 *
 * Filters:
 *   - `organization` — UUID of organization (use the literal "global"
 *     to filter to roles where `organization_id IS NULL`).
 *   - `scope` — `global` or `org`.
 *   - `permission` — permission key; returns roles holding that key.
 *
 * `q` matches case-insensitively against `key` and `name`.
 *
 * Caller MUST hold `admin.roles.read`.
 */
const SCOPE_GLOBAL = "global";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.roles.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: [
      "key",
      "name",
      "created_at",
      "permission_count",
      "member_count",
      "organization_name",
    ],
    allowedFilters: ["organization", "scope", "permission"],
    defaultSort: [{ field: "key", direction: "asc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  // LEFT JOIN so each role carries its owning org's name. Global roles have
  // `organization_id IS NULL`, so the joined name is null for them. 1:1 on the
  // org PK, so the row count (reused for the COUNT(*) total) is unchanged.
  let base = db
    .selectFrom("app_roles as r")
    .leftJoin("app_organizations as o", "o.id", "r.organization_id");

  const orgFilter = query.filters.organization;
  if (typeof orgFilter === "string") {
    if (orgFilter === SCOPE_GLOBAL) {
      base = base.where("r.organization_id", "is", null);
    } else if (UUID_RE.test(orgFilter)) {
      base = base.where("r.organization_id", "=", orgFilter);
    }
  }

  const scopeFilter = query.filters.scope;
  if (scopeFilter === "global") {
    base = base.where("r.organization_id", "is", null);
  } else if (scopeFilter === "org") {
    base = base.where("r.organization_id", "is not", null);
  }

  const permFilter = query.filters.permission;
  if (typeof permFilter === "string" && permFilter.length > 0 && permFilter.length <= 200) {
    base = base.where((eb) =>
      eb.exists(
        eb
          .selectFrom("app_role_permissions as rp")
          .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
          .select(sql`1`.as("one"))
          .whereRef("rp.role_id", "=", "r.id")
          .where("p.key", "=", permFilter),
      ),
    );
  }

  if (query.q) {
    const like = `%${query.q}%`;
    base = base.where((eb) => eb.or([eb("r.key", "ilike", like), eb("r.name", "ilike", like)]));
  }

  // ADR-0001: an org admin sees only roles owned by their org; global
  // roles (organization_id IS NULL) are SUPERADMIN-only. A null scope (org
  // admin with no resolvable org) yields an empty list, never "all".
  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return NextResponse.json(buildListResponse([], 0, query));
  }
  if (scope.kind === "org") {
    base = base.where("r.organization_id", "=", scope.organizationId);
  }

  // Precompute the permission / member counts as GROUPed derived tables and
  // LEFT JOIN them, instead of correlated scalar sub-selects (P2-17). With a
  // sub-select aliased as a sort field, `ORDER BY permission_count` forces
  // Postgres to evaluate the count for EVERY matching role, sort the whole
  // set, then LIMIT — O(rows) sub-select runs on a superadmin's deep grid,
  // compounding the `count(*) over()` materialization. The grouped join lets
  // the planner hash-aggregate each table once. Each derived table is unique
  // on the role id (GROUP BY role_id), so the join stays 1:1 and the
  // `count(*)` total (computed below on the join-free `base`) is unchanged.
  const withCounts = base
    .leftJoin(
      (eb) =>
        eb
          .selectFrom("app_role_permissions")
          .select(["role_id", sql<string>`count(*)`.as("c")])
          .groupBy("role_id")
          .as("rpc"),
      (join) => join.onRef("rpc.role_id", "=", "r.id"),
    )
    .leftJoin(
      (eb) =>
        eb
          .selectFrom("app_user_roles")
          .select(["role_id", sql<string>`count(distinct app_user_id)`.as("c")])
          .groupBy("role_id")
          .as("urc"),
      (join) => join.onRef("urc.role_id", "=", "r.id"),
    );

  const itemsQuery = applySortAndPagination(
    withCounts.select([
      "r.id",
      "r.organization_id",
      "o.name as organization_name",
      "r.key",
      "r.name",
      "r.description",
      "r.created_at",
      sql<string>`coalesce(${sql.ref("rpc.c")}, 0)`.as("permission_count"),
      sql<string>`coalesce(${sql.ref("urc.c")}, 0)`.as("member_count"),
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
    organization_id: row.organization_id,
    organization_name: row.organization_name ?? null,
    key: row.key,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    permission_count: Number(row.permission_count ?? 0),
    member_count: Number(row.member_count ?? 0),
  }));

  return NextResponse.json(buildListResponse(normalised, total, query));
}

/**
 * POST /api/administrator/roles
 *
 * Creates a new application role. Caller MUST hold `admin.roles.create`.
 *
 *   - `(organization_id, key)` is unique by DB constraint.
 *   - Global keys (`organization_id IS NULL`) must additionally be
 *     globally unique — we enforce this in code because the SQL unique
 *     index treats NULLs as distinct.
 */

export async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.roles.create");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.create",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = createRoleSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;
  const orgId = input.organizationId ?? null;

  // ADR-0001: an org admin may create roles ONLY within their own org —
  // never a global role and never another org's. SUPERADMIN bypasses.
  if (!isSuperadmin(guard.access) && (orgId === null || !canAccessOrg(guard.access, orgId))) {
    return adminErrorResponse("forbidden", 403, request);
  }

  // Manual uniqueness check for global keys (NULLs are distinct in
  // postgres unique indexes).
  if (orgId === null) {
    const dup = await db
      .selectFrom("app_roles")
      .select(["id"])
      .where("organization_id", "is", null)
      .where("key", "=", input.key)
      .executeTakeFirst();
    if (dup) {
      return adminErrorResponse("key_taken", 409, request);
    }
  }

  let inserted: { id: string; key: string };
  try {
    inserted = await db
      .insertInto("app_roles")
      .values({
        organization_id: orgId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
      })
      .returning(["id", "key"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    // Catches the org-scoped (organization_id, key) uniqueness violation.
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("key_taken", 409, request);
    }
    throw err;
  }

  await auditRoleAction("admin.role.created", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: orgId,
    metadata: { roleId: inserted.id, key: inserted.key },
  });

  return NextResponse.json({ ok: true, id: inserted.id, key: inserted.key }, { status: 201 });
}
