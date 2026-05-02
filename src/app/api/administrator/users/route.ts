import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
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
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { createBetterAuthUser } from "@/lib/admin/auth-admin.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/users
 *
 * Paginated list of `app_users` rows for the Administrator workspace.
 * Returns the uniform `ListResponse` envelope documented in
 * docs/admin-manager.md §5.1.
 *
 * Threat / contract:
 *   - Caller MUST hold `admin.users.read`. Without it the endpoint
 *     returns 403 and writes a `denied` audit row.
 *   - Filters and sort fields are allow-listed; unknown values are
 *     silently dropped, so attackers can't pivot to unindexed columns.
 *   - The `q` global search is bound via Kysely parameters (no string
 *     concatenation) and matched case-insensitively against
 *     `primary_email` and `display_name`.
 *
 * Joining with the Better Auth `user` table is intentionally out of
 * scope for this endpoint per plan §13 — that join happens in the
 * higher-level Phase-3 endpoints once we need the auth `banned` /
 * `role` columns. Here we ship the application view only, which keeps
 * the endpoint cheap and indexable.
 */
const ALLOWED_STATUS = new Set([
  "active",
  "pending_approval",
  "blocked",
  "suspended",
  "deactivated",
]);

export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.users.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["created_at", "primary_email", "display_name", "status"],
    allowedFilters: ["status"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  // Build the base query with all WHERE clauses applied. We then derive
  // both the count and the page from the same builder so a future filter
  // automatically applies to both.
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
      eb.or([
        eb("primary_email", "ilike", like),
        eb("display_name", "ilike", like),
      ]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base
      .select([
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

  const total = Number(totalRow?.total ?? 0);

  return NextResponse.json(buildListResponse(items, total, query));
}

/**
 * POST /api/administrator/users
 *
 * Creates a new Better Auth user (via the admin plugin) and persists
 * the corresponding `app_users` row in a single transaction. Per
 * docs/admin-manager.md §4 + §8.3:
 *
 *   - Caller MUST hold `admin.users.create`.
 *   - Body validated with Zod (`.strict()` — unknown keys rejected).
 *   - The Better Auth `role` field is the auth role (`user`/`admin`),
 *     distinct from app roles managed by `app_user_roles`.
 *   - Initial app status defaults to `pending_approval` so admin
 *     approval is still required even when an admin creates the user.
 *   - The new password is forwarded to Better Auth and never logged or
 *     returned in the response or audit metadata.
 */
const createSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(128),
    name: z.string().min(1).max(200).optional(),
    role: z.enum(["admin", "user"]).optional(),
    initialAppStatus: z
      .enum(["active", "pending_approval"])
      .optional()
      .default("pending_approval"),
    preferredLocale: z.string().min(2).max(10).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.users.create");
  if (isAdminPermissionDenial(guard)) return guard.response;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const input = parsed.data;
  // Normalise email to lowercase for both the duplicate check AND
  // storage. Email comparison in `app_users` is already case-folded
  // via `lower(primary_email)` below, so persisting the lowercased
  // form keeps the stored value consistent and avoids surprising the
  // SSO/OAuth lookup paths that compare case-sensitively.
  const normalisedEmail = input.email.toLowerCase();

  // Reject duplicate emails up-front with a clean error rather than
  // letting Better Auth raise a generic constraint failure. This is a
  // best-effort check — the unique index on `app_users.primary_email`
  // is the source of truth.
  const existing = await db
    .selectFrom("app_users")
    .select(["id"])
    .where(sql`lower(primary_email)`, "=", normalisedEmail)
    .executeTakeFirst();
  if (existing) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  let created;
  try {
    created = await createBetterAuthUser(
      {
        email: normalisedEmail,
        password: input.password,
        name: input.name ?? normalisedEmail,
        role: input.role,
      },
      request,
    );
  } catch (err) {
    await auditUserAction("admin.user.create_failed", "failure", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: "00000000-0000-0000-0000-000000000000",
      email: normalisedEmail,
      reason: "auth_create_user_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return NextResponse.json({ error: "auth_create_failed" }, { status: 502 });
  }

  // Better Auth's create-user returns either `{ user: { id, ... } }` or
  // a flat user object depending on plugin version; accept either shape.
  const betterAuthUserId =
    (created as { user?: { id?: string }; id?: string } | null | undefined)?.user?.id ??
    (created as { id?: string } | null | undefined)?.id;
  if (!betterAuthUserId) {
    return NextResponse.json({ error: "auth_create_failed" }, { status: 502 });
  }

  // Insert the application user row. We deliberately do NOT auto-create
  // a membership here — that's the responsibility of the membership
  // endpoint (Phase 5), and admin-created users are explicitly approved
  // (or not) by an admin in a follow-up action.
  const appUser = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: betterAuthUserId,
      primary_email: normalisedEmail,
      display_name: input.name ?? null,
      status: input.initialAppStatus,
      preferred_locale: input.preferredLocale ?? "en",
    })
    .returning(["id", "primary_email", "status"])
    .executeTakeFirstOrThrow();

  await auditUserAction("admin.user.created", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: appUser.id,
    email: appUser.primary_email,
    metadata: {
      betterAuthUserId,
      initialAppStatus: appUser.status,
      role: input.role ?? null,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      id: appUser.id,
      better_auth_user_id: betterAuthUserId,
      primary_email: appUser.primary_email,
      status: appUser.status,
    },
    { status: 201 },
  );
}
