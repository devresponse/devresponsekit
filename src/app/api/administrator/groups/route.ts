import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, isSuperadmin, resolveOrgScope } from "@/lib/admin/access-scope.server";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;

/**
 * GET /api/administrator/groups
 *
 * Paginated list of `app_groups` with role/member counts (ADR-0002).
 * `q` matches `key` and `name`. Caller MUST hold `admin.groups.read`.
 *
 * ADR-0001: an org admin sees only their org's groups; a null scope yields
 * an empty page (groups are always tenant-scoped, so there is no global set).
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.groups.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["key", "name", "created_at", "role_count", "member_count"],
    allowedFilters: ["organization"],
    defaultSort: [{ field: "key", direction: "asc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return NextResponse.json(buildListResponse([], 0, query));
  }

  let base = db.selectFrom("app_groups as g");
  if (scope.kind === "org") {
    base = base.where("g.organization_id", "=", scope.organizationId);
  }
  const orgFilter = query.filters.organization;
  if (typeof orgFilter === "string" && UUID_RE.test(orgFilter)) {
    base = base.where("g.organization_id", "=", orgFilter);
  }
  if (query.q) {
    const like = `%${query.q}%`;
    base = base.where((eb) => eb.or([eb("g.key", "ilike", like), eb("g.name", "ilike", like)]));
  }

  const itemsQuery = applySortAndPagination(
    base.select((eb) => [
      "g.id",
      "g.organization_id",
      "g.key",
      "g.name",
      "g.description",
      "g.created_at",
      eb
        .selectFrom("app_group_roles as gr")
        .select(sql<string>`count(*)`.as("c"))
        .whereRef("gr.group_id", "=", "g.id")
        .as("role_count"),
      eb
        .selectFrom("app_group_memberships as gm")
        .select(sql<string>`count(*)`.as("c"))
        .whereRef("gm.group_id", "=", "g.id")
        .as("member_count"),
    ]),
    query,
  );

  const [items, totalRow] = await Promise.all([
    itemsQuery.execute(),
    base.select(sql<string>`count(*)`.as("total")).executeTakeFirst(),
  ]);

  const total = Number(totalRow?.total ?? 0);
  const normalised = items.map((row) => ({
    id: row.id,
    organization_id: row.organization_id,
    key: row.key,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    role_count: Number(row.role_count ?? 0),
    member_count: Number(row.member_count ?? 0),
  }));

  return NextResponse.json(buildListResponse(normalised, total, query));
}

/**
 * POST /api/administrator/groups
 *
 * Creates a group in an organization. Caller MUST hold `admin.groups.create`.
 *
 * ADR-0001/0002: groups are ALWAYS tenant-scoped — an org admin may create
 * only in their own org (the client-supplied `organizationId` is ignored); a
 * SUPERADMIN must name the target org. `(organization_id, key)` is unique.
 */
const createSchema = z
  .object({
    key: z.string().min(1).max(120).regex(KEY_RE),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    organizationId: z.string().regex(UUID_RE).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.groups.create");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.create",
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
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  // Resolve the owning org. ORG ADMIN → their own org (ignore any supplied
  // id). SUPERADMIN → the supplied org (required — there are no global groups).
  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return adminErrorResponse("forbidden", 403, request);
  }
  let organizationId: string;
  if (scope.kind === "org") {
    organizationId = scope.organizationId;
  } else {
    if (!parsed.data.organizationId) {
      return adminErrorResponse("organization_required", 400, request);
    }
    organizationId = parsed.data.organizationId;
  }

  // The org must exist and (defence in depth) be reachable by the caller.
  const org = await db
    .selectFrom("app_organizations")
    .select(["id"])
    .where("id", "=", organizationId)
    .executeTakeFirst();
  if (!org || !canAccessOrg(guard.access, organizationId)) {
    return adminErrorResponse(
      isSuperadmin(guard.access) ? "organization_not_found" : "forbidden",
      isSuperadmin(guard.access) ? 404 : 403,
      request,
    );
  }

  let inserted: { id: string; key: string };
  try {
    inserted = await db
      .insertInto("app_groups")
      .values({
        organization_id: organizationId,
        key: parsed.data.key,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
      })
      .returning(["id", "key"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("key_taken", 409, request);
    }
    throw err;
  }

  await auditOrgAction("admin.group.created", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId,
    metadata: { groupId: inserted.id, key: inserted.key },
  });

  return NextResponse.json({ ok: true, id: inserted.id, key: inserted.key }, { status: 201 });
}
