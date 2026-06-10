import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/permissions
 *
 * Paginated read of `app_permissions` enriched with a
 * `usedByRoleCount` aggregate so the catalog grid (§8.7) can render
 * the "Roles using this" column without N+1 queries.
 *
 * Caller MUST hold `admin.roles.read` (the catalog is informational
 * for any admin role-reader; mutations require the stronger
 * `admin.permissions.manage`).
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.roles.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["key", "description", "used_by_role_count"],
    defaultSort: [{ field: "key", direction: "asc" }],
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  let base = db.selectFrom("app_permissions as p");
  if (query.q) {
    const like = `%${query.q}%`;
    base = base.where((eb) =>
      eb.or([eb("p.key", "ilike", like), eb("p.description", "ilike", like)]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base.select((eb) => [
      "p.id",
      "p.key",
      "p.description",
      eb
        .selectFrom("app_role_permissions as rp")
        .select(sql<string>`count(*)`.as("c"))
        .whereRef("rp.permission_id", "=", "p.id")
        .as("used_by_role_count"),
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
    key: row.key,
    description: row.description,
    used_by_role_count: Number(row.used_by_role_count ?? 0),
  }));

  return NextResponse.json(buildListResponse(normalised, total, query));
}

/**
 * POST /api/administrator/permissions
 *
 * Adds a new entry to the permission catalog. Caller MUST hold
 * `admin.permissions.manage`. Note: adding a permission alone grants
 * no power — it must subsequently be attached to a role.
 */
const KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;
const createSchema = z
  .object({
    key: z.string().min(1).max(120).regex(KEY_RE),
    description: z.string().max(1000).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.permissions.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

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

  let inserted: { id: string; key: string };
  try {
    inserted = await db
      .insertInto("app_permissions")
      .values({ key: parsed.data.key, description: parsed.data.description ?? null })
      .returning(["id", "key"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("key_taken", 409, request);
    }
    throw err;
  }

  await auditRoleAction("admin.permission.created", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    metadata: { permissionId: inserted.id, key: inserted.key },
  });

  return NextResponse.json({ ok: true, id: inserted.id, key: inserted.key }, { status: 201 });
}
