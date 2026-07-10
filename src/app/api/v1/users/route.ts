import type { NextRequest } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { createBetterAuthUser } from "@/lib/admin/auth-admin.server";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
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

  // Org boundary (ADR-0001): a user's tenant is its membership, so an org
  // admin sees only users who hold a membership in their org. SUPERADMIN
  // sees all. A null scope (org admin with no org) sees nothing.
  const scope = resolveOrgScope(guard.grant.caller.access);
  if (!scope) {
    return v1JsonResponse(buildListResponse([], 0, query), request);
  }

  let base = db.selectFrom("app_users");
  if (scope.kind === "org") {
    const orgId = scope.organizationId;
    base = base.where((eb) =>
      eb.exists(
        eb
          .selectFrom("app_organization_memberships as m")
          .select("m.id")
          .whereRef("m.app_user_id", "=", "app_users.id")
          .where("m.organization_id", "=", orgId),
      ),
    );
  }
  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && ALLOWED_STATUS.has(statusFilter)) {
    base = base.where("status", "=", statusFilter);
  } else if (Array.isArray(statusFilter)) {
    const cleaned = statusFilter.filter((v) => ALLOWED_STATUS.has(v));
    if (cleaned.length > 0) base = base.where("status", "in", cleaned);
  }
  if (query.q) {
    const like = likeContains(query.q);
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

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  return v1JsonResponse(buildListResponse(items, total, query), request);
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
  } catch (err) {
    return problemResponse("internal_error", 502, request, {
      cause: err,
      detail: "Identity provider rejected the user creation.",
      requestId: grant.requestId,
    });
  }
  const betterAuthUserId =
    (created as { user?: { id?: string }; id?: string })?.user?.id ??
    (created as { id?: string })?.id;
  if (!betterAuthUserId) {
    return problemResponse("internal_error", 502, request, {
      cause: new Error("identity provider returned no user id on create"),
      requestId: grant.requestId,
    });
  }

  let appUser;
  try {
    appUser = await db
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
  } catch (err) {
    // OPS-OBS-1: the up-front email check is best-effort; a concurrent create
    // can still lose the unique race, and any other insert failure here would
    // otherwise surface as a generic 500 with no audit row (unlike the admin
    // twin). Audit the failure and return a typed problem — which now logs the
    // 5xx to stdout regardless of Sentry.
    await auditUserAction("admin.user.create_failed", "error", {
      request,
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: "00000000-0000-0000-0000-000000000000",
      email,
      requestId: grant.requestId,
      reason: isUniqueViolation(err) ? "email_taken_race" : "db_insert_failed",
      metadata: { betterAuthUserId, via: "api.v1" },
    });
    if (isUniqueViolation(err)) {
      return problemResponse("conflict", 409, request, {
        detail: "A user with this email already exists.",
        requestId: grant.requestId,
      });
    }
    return problemResponse("internal_error", 502, request, {
      cause: err,
      detail: "Failed to persist the user.",
      requestId: grant.requestId,
    });
  }

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

/** Postgres unique-violation (SQLSTATE 23505) detector — mirrors the admin twin. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}
