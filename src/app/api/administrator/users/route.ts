import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { createUserSchema } from "@/lib/validation/users";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { hasCrossOrgReach, resolveOrgScope } from "@/lib/admin/access-scope.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { createBetterAuthUser } from "@/lib/admin/auth-admin.server";
import { isAuthEmailTakenError } from "@/lib/admin/auth-email-taken";
import { withAdminRoute } from "@/lib/route-handler.server";

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
 * scope for this endpoint: we ship the application view only (plus each
 * user's org names), which keeps the query cheap and indexable. Nothing
 * in the console reads the auth-side `banned` / `role` columns back —
 * `/users/[id]/ban` and `/users/[id]/role` write them through
 * `auth.api.*` without a read (docs/admin-manager.md §8.1), and the ban
 * flag is consulted on the machine-API path (`isBetterAuthUserBanned`).
 */
const ALLOWED_STATUS = new Set([
  "active",
  "pending_approval",
  "blocked",
  "suspended",
  "deactivated",
]);

export const GET = withAdminRoute(async function GET(request: NextRequest) {
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
  // Org boundary (ADR-0001): an org admin sees only users with a
  // membership in their org; superadmin sees all. Null scope → none.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return NextResponse.json(buildListResponse([], 0, query));

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

  // Organization name(s) the user belongs to — shown as a grid column so a
  // SUPERADMIN can tell which org each cross-org user is in. A correlated
  // scalar subquery (not a join) keeps the result one row per user, so the
  // count and pagination stay correct even for multi-org users. It is scoped
  // the SAME way as the row set above: an org admin only ever sees THEIR
  // org's name (revealing a user's OTHER orgs would itself be a cross-tenant
  // leak); a SUPERADMIN sees every org the user belongs to.
  const orgNames =
    scope.kind === "org"
      ? sql<string | null>`(
          select string_agg(o.name, ', ' order by o.name)
          from app_organization_memberships m
          join app_organizations o on o.id = m.organization_id
          where m.app_user_id = app_users.id and m.organization_id = ${scope.organizationId}
        )`
      : sql<string | null>`(
          select string_agg(o.name, ', ' order by o.name)
          from app_organization_memberships m
          join app_organizations o on o.id = m.organization_id
          where m.app_user_id = app_users.id
        )`;

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
      orgNames.as("organization_names"),
    ]),
    query,
  );

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  return NextResponse.json(buildListResponse(items, total, query));
});

/**
 * POST /api/administrator/users
 *
 * Creates a new Better Auth user (via the admin plugin), then inserts the
 * corresponding `app_users` row — two sequential writes, NOT one
 * transaction (review #136). An address Better Auth already holds is a 409,
 * whether a concurrent create won the race or an earlier identity has no
 * `app_users` row (F-30). A failed `app_users` insert is a 500 that leaves the
 * Better Auth user behind for reconciliation, its id in the
 * `admin.user.create_failed` row. Per docs/admin-manager.md §4 + §8.1:
 *
 *   - Caller MUST hold `admin.users.create`.
 *   - Body validated with Zod (`.strict()` — unknown keys rejected).
 *   - The Better Auth `role` field is the auth role (`user`/`admin`),
 *     distinct from app roles managed by `app_user_roles`. `admin` needs
 *     cross-org reach (403 otherwise), as on `POST /users/[id]/role` (F-13).
 *   - Initial app status defaults to `pending_approval` so admin
 *     approval is still required even when an admin creates the user.
 *   - The new password is forwarded to Better Auth and never logged or
 *     returned in the response or audit metadata.
 *
 * The request body is validated with the shared `createUserSchema`
 * (`@/lib/validation/users`) — the SAME schema the create-user form uses, so
 * client and server enforce identical rules.
 */

export const POST = withAdminRoute(async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.users.create");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.create",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = createUserSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const input = parsed.data;

  // F-13: the Better Auth `admin` role is a platform role, and minting it is
  // SUPERADMIN-only (`POST /users/[id]/role`, same predicate). The plugin used
  // to check it here against the actor's own role; `createBetterAuthUser` now
  // runs as a trusted server call, so this route is the only check.
  if (input.role === "admin" && !hasCrossOrgReach(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  // Normalise email to lowercase for both the duplicate check AND
  // storage. Email comparison in `app_users` is already case-folded
  // via `lower(primary_email)` below, so persisting the lowercased
  // form keeps the stored value consistent and avoids surprising the
  // SSO/OAuth lookup paths that compare case-sensitively.
  const normalisedEmail = input.email.toLowerCase();

  // Reject duplicate emails up-front with a clean error. Best-effort only:
  // `app_users` has NO unique index on the email (its one unique key is
  // `better_auth_user_id`). The source of truth is Better Auth's `"user"`
  // table, whose `email` is unique, so a concurrent create of the same
  // address, or an address Better Auth holds without an `app_users` row,
  // passes this check and is refused inside `createBetterAuthUser` below
  // (F-30).
  const existing = await db
    .selectFrom("app_users")
    .select(["id"])
    .where(sql`lower(primary_email)`, "=", normalisedEmail)
    .executeTakeFirst();
  if (existing) {
    return adminErrorResponse("email_taken", 409, request);
  }

  let created;
  try {
    created = await createBetterAuthUser({
      email: normalisedEmail,
      password: input.password,
      name: input.name?.trim() || normalisedEmail,
      role: input.role,
      // F-03: only a creator with cross-org reach may vouch for an address;
      // anyone else's creation carries no mailbox proof.
      emailUnproven: !hasCrossOrgReach(guard.access),
    });
  } catch (err) {
    // F-30: no `app_users` row exists for this address, so the row names none
    // (`app_user_id` is a foreign key: the nil UUID this used to pass failed
    // it, and the route answered 500 with no audit row). The address is in
    // `email`. An address Better Auth already holds is the documented 409,
    // like the up-front check, and still audited: it means a concurrent create
    // won, or an identity exists with no `app_users` row to find.
    const emailTaken = isAuthEmailTakenError(err);
    await auditUserAction("admin.user.create_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: null,
      email: normalisedEmail,
      requestId: guard.requestId,
      reason: emailTaken ? "auth_user_exists" : "auth_create_user_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    if (emailTaken) return adminErrorResponse("email_taken", 409, request);
    return adminErrorResponse("auth_create_failed", 502, request, { cause: err });
  }

  // Better Auth's create-user returns either `{ user: { id, ... } }` or
  // a flat user object depending on plugin version; accept either shape.
  const betterAuthUserId =
    (created as { user?: { id?: string }; id?: string } | null | undefined)?.user?.id ??
    (created as { id?: string } | null | undefined)?.id;
  if (!betterAuthUserId) {
    // F-30: a failure like the others past the up-front check, so audited like
    // them, naming no `app_users` row. Better Auth may have created an identity
    // it did not name; the key names (never the values) of what it returned
    // are the only clue.
    await auditUserAction("admin.user.create_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: null,
      email: normalisedEmail,
      requestId: guard.requestId,
      reason: "auth_create_no_id",
      metadata: {
        returnedKeys: typeof created === "object" && created !== null ? Object.keys(created) : [],
      },
    });
    return adminErrorResponse("auth_create_failed", 502, request, {
      cause: new Error("identity provider returned no user id on create"),
    });
  }

  // Insert the application user row. We deliberately do NOT auto-create
  // a membership here — that's the responsibility of the membership
  // endpoint (Phase 5), and admin-created users are explicitly approved
  // (or not) by an admin in a follow-up action.
  //
  // F-30: this insert cannot lose an email race. Better Auth refused the
  // loser above, and the only unique key here is `better_auth_user_id`,
  // which that call just minted; the 23505 → `email_taken` branch that used
  // to sit here could not fire for an email. Any failure is a fault in our
  // own store: the 500 a throw would give (docs/admin-manager.md §5.1), plus
  // the audit row a throw would not write. The row names the new Better Auth
  // id, which is left without an `app_users` row, so an operator can
  // reconcile it; until then a retry of this address answers 409.
  let appUser;
  try {
    appUser = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: betterAuthUserId,
        primary_email: normalisedEmail,
        display_name: input.name?.trim() || null,
        status: input.initialAppStatus,
        preferred_locale: input.preferredLocale ?? "en",
      })
      .returning(["id", "primary_email", "status"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    await auditUserAction("admin.user.create_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: null,
      email: normalisedEmail,
      requestId: guard.requestId,
      reason: "db_insert_failed",
      metadata: { betterAuthUserId },
    });
    return adminErrorResponse("internal_error", 500, request, { cause: err });
  }

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
});
