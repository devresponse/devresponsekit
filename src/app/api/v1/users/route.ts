import type { NextRequest } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { createBetterAuthUser } from "@/lib/admin/auth-admin.server";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set([
  "active",
  "pending_approval",
  "blocked",
  "suspended",
  "deactivated",
]);

/**
 * GET /api/v1/users
 *
 * Versioned REST adapter over the same `app_users` listing the admin
 * surface serves (design §8.2). Requires `admin.users.read`. Reuses the
 * shared list-query helpers so the pagination/sort/filter contract is
 * identical to `/api/administrator/users`.
 */
export async function GET(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.users.read");
  if (!guard.ok) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["created_at", "primary_email", "display_name", "status"],
    allowedFilters: ["status"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

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
      eb.or([eb("primary_email", "ilike", like), eb("display_name", "ilike", like)]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base.select([
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

  return v1JsonResponse(buildListResponse(items, Number(totalRow?.total ?? 0), query), request);
}

/**
 * POST /api/v1/users
 *
 * Creates a Better Auth user + `app_users` row. Requires
 * `admin.users.create`. Defaults to `pending_approval`. The password is
 * forwarded to Better Auth and never logged or echoed.
 */
const createSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(128),
    name: z.string().min(1).max(200).optional(),
    role: z.enum(["admin", "user"]).optional(),
    initialAppStatus: z.enum(["active", "pending_approval"]).optional().default("pending_approval"),
    preferredLocale: z.string().min(2).max(10).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.users.create");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.users.create", grant, request);
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }
  const input = parsed.data;
  const email = input.email.toLowerCase();

  const existing = await db
    .selectFrom("app_users")
    .select(["id"])
    .where(sql`lower(primary_email)`, "=", email)
    .executeTakeFirst();
  if (existing) {
    return problemResponse("conflict", 409, request, {
      detail: "A user with this email already exists.",
      requestId: grant.requestId,
    });
  }

  let created: unknown;
  try {
    created = await createBetterAuthUser(
      { email, password: input.password, name: input.name ?? email, role: input.role },
      request,
    );
  } catch {
    return problemResponse("internal_error", 502, request, {
      detail: "Identity provider rejected the user creation.",
      requestId: grant.requestId,
    });
  }
  const betterAuthUserId =
    (created as { user?: { id?: string }; id?: string })?.user?.id ??
    (created as { id?: string })?.id;
  if (!betterAuthUserId) {
    return problemResponse("internal_error", 502, request, { requestId: grant.requestId });
  }

  const appUser = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: betterAuthUserId,
      primary_email: email,
      display_name: input.name ?? null,
      status: input.initialAppStatus,
      preferred_locale: input.preferredLocale ?? "en",
    })
    .returning(["id", "primary_email", "status"])
    .executeTakeFirstOrThrow();

  await auditUserAction("admin.user.created", "success", {
    request,
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: appUser.id,
    email: appUser.primary_email,
    requestId: grant.requestId,
    metadata: { betterAuthUserId, via: "api.v1", initialAppStatus: appUser.status },
  });

  return v1JsonResponse(
    {
      id: appUser.id,
      betterAuthUserId,
      email: appUser.primary_email,
      status: appUser.status,
    },
    request,
    { status: 201, requestId: grant.requestId },
  );
}
