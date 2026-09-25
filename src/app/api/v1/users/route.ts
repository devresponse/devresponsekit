import type { NextRequest } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { preferredLocaleSchema } from "@/lib/validation/users";
import { userNameSchema } from "@/lib/user-name";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { createBetterAuthUser } from "@/lib/admin/auth-admin.server";
import { isAuthEmailTakenError } from "@/lib/admin/auth-email-taken";
import {
  auditCreationMembership,
  insertCreatedUser,
  type CreatedAppUser,
} from "@/lib/admin/user-create.server";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQueryStrict,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { V1_USERS_LIST } from "@/lib/api-auth/v1-list-contract";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import {
  actingOrganizationId,
  hasCrossOrgReach,
  resolveOrgScope,
  scopeOrganizationId,
} from "@/lib/admin/access-scope.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";
import { withV1Route } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/users
 *
 * Versioned REST adapter over the same `app_users` listing the admin
 * surface serves (design §8.2). Requires `admin.users.read`. Reuses the
 * shared list-query helpers for pagination and sorting, but parses strictly
 * (F-34): `filter[status]` may repeat and matches any of its values, and an
 * unknown status, filter or sort is a 400 rather than silently dropped — a
 * dropped status filter listed EVERY user as the answer to "which are
 * blocked?".
 */
export const GET = withV1Route(async function GET(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.users.read");
  if (!guard.ok) return guard.response;

  const parsed = parseListQueryStrict(request.nextUrl.searchParams, {
    allowedSortFields: V1_USERS_LIST.sortFields,
    search: V1_USERS_LIST.search,
    filters: V1_USERS_LIST.filters,
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });
  if (!parsed.ok) {
    return problemResponse("invalid_request", 400, request, {
      detail: parsed.detail,
      requestId: guard.grant.requestId,
    });
  }
  const { query } = parsed;

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
  // Every value was checked against the published vocabulary by the parser.
  const statuses = query.filters.status;
  if (statuses) base = base.where("status", "in", statuses);
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
});

/**
 * POST /api/v1/users
 *
 * Creates a Better Auth user + `app_users` row. Requires
 * `admin.users.create`. Works for every caller the guard admits — API key,
 * JWT, the MCP `createUser` tool — since the Better Auth write no longer needs
 * a cookie session (F-13). `role: "admin"` also requires cross-org reach,
 * which only a superadmin's cookie session has: every API key and JWT is
 * bound to one org (MACHINE-2), so a bearer caller always gets 403 for it.
 * Defaults to `pending_approval`. A caller without cross-org reach (every
 * bearer, an org admin's session) enrols the user in its own org with that
 * same status, so it can act on the user it created; a superadmin's cookie
 * session creates the user in no org (`insertCreatedUser`). The password is
 * forwarded to Better Auth and never logged or echoed. An address that already
 * has an account is a 409, including one Better Auth holds with no `app_users`
 * row and the loser of a concurrent create (F-30); a failure to store the new
 * user is a 502.
 */
const createSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(128),
    // F-21: the shared name rule (`user-name.ts`), the bound the spec states.
    name: userNameSchema.optional(),
    role: z.enum(["admin", "user"]).optional(),
    initialAppStatus: z.enum(["active", "pending_approval"]).optional().default("pending_approval"),
    // Review #71/#80: constrained to the app's supported locales via the ONE
    // shared schema — a free-form 2-10 char string used to be stored verbatim.
    preferredLocale: preferredLocaleSchema.optional(),
  })
  .strict();

const EMAIL_TAKEN_DETAIL = "A user with this email already exists.";

export const POST = withV1Route(async function POST(request: NextRequest) {
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

  // F-13: minting the Better Auth platform role is SUPERADMIN-only, as on the
  // admin twin and `POST /api/administrator/users/[id]/role`. Every API key and
  // JWT is org-bound (MACHINE-2) and so has no cross-org reach: on this surface
  // only a superadmin's cookie session can mint one.
  if (input.role === "admin" && !hasCrossOrgReach(grant.caller.access)) {
    return problemResponse("forbidden", 403, request, { requestId: grant.requestId });
  }

  // The new user joins the org a confined caller acts in (`insertCreatedUser`).
  // A confined caller with no org would create a user it cannot reach, so it is
  // refused before anything is written, as a null scope is everywhere else.
  const scope = resolveOrgScope(grant.caller.access);
  if (!scope) {
    return problemResponse("forbidden", 403, request, { requestId: grant.requestId });
  }

  // Best-effort, as on the admin twin: `app_users` has no unique key on the
  // email, so Better Auth's unique `"user".email` refuses whatever passes this
  // (F-30, below).
  const existing = await db
    .selectFrom("app_users")
    .select(["id"])
    .where(sql`lower(primary_email)`, "=", email)
    .executeTakeFirst();
  if (existing) {
    return problemResponse("conflict", 409, request, {
      detail: EMAIL_TAKEN_DETAIL,
      requestId: grant.requestId,
    });
  }

  let created: unknown;
  try {
    created = await createBetterAuthUser({
      email,
      password: input.password,
      name: input.name ?? email,
      role: input.role,
      // F-03: only a creator with cross-org reach may vouch for an address.
      emailUnproven: !hasCrossOrgReach(grant.caller.access),
    });
  } catch (err) {
    // F-30: an address Better Auth already holds (a concurrent create won, or
    // an identity has no `app_users` row to find) is the 409 this route
    // documents, not an identity-provider failure. Both are audited as on the
    // admin twin, naming no `app_users` row: none exists for this address.
    const emailTaken = isAuthEmailTakenError(err);
    await auditUserAction("admin.user.create_failed", "error", {
      request,
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: null,
      organizationId: actingOrganizationId(grant.caller.access),
      email,
      requestId: grant.requestId,
      reason: emailTaken ? "auth_user_exists" : "auth_create_user_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", via: "api.v1" },
    });
    if (emailTaken) {
      return problemResponse("conflict", 409, request, {
        detail: EMAIL_TAKEN_DETAIL,
        requestId: grant.requestId,
      });
    }
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
    // F-30: audited like every other failure past the up-front check (see the
    // admin twin): no `app_users` row, and only the key names of what Better
    // Auth returned, never the values.
    await auditUserAction("admin.user.create_failed", "error", {
      request,
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: null,
      organizationId: actingOrganizationId(grant.caller.access),
      email,
      requestId: grant.requestId,
      reason: "auth_create_no_id",
      metadata: {
        returnedKeys: typeof created === "object" && created !== null ? Object.keys(created) : [],
        via: "api.v1",
      },
    });
    return problemResponse("internal_error", 502, request, {
      cause: new Error("identity provider returned no user id on create"),
      requestId: grant.requestId,
    });
  }

  let stored: CreatedAppUser;
  try {
    stored = await insertCreatedUser({
      betterAuthUserId,
      email,
      displayName: input.name ?? null,
      status: input.initialAppStatus,
      preferredLocale: input.preferredLocale ?? "en",
      enrolOrganizationId: scopeOrganizationId(scope),
    });
  } catch (err) {
    // OPS-OBS-1: an insert failure here would otherwise surface as a generic
    // 500 with no audit row. Audit it and return a typed problem, which logs
    // the 5xx to stdout regardless of Sentry.
    //
    // F-30: the row names NO `app_users` row, because this insert is what
    // failed to create one (a failed membership insert rolls it back too); the
    // nil UUID it used to name failed the audit's foreign key, so this branch
    // answered 500 with no audit row after all. The new Better Auth id, now
    // without an `app_users` row, is in metadata. Nor can this insert lose an
    // email race: Better Auth refused the loser above, and the one unique key
    // here is the `better_auth_user_id` that call just minted, so the 23505 →
    // 409 branch that used to sit here is gone.
    await auditUserAction("admin.user.create_failed", "error", {
      request,
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: null,
      organizationId: actingOrganizationId(grant.caller.access),
      email,
      requestId: grant.requestId,
      reason: "db_insert_failed",
      metadata: { betterAuthUserId, via: "api.v1" },
    });
    return problemResponse("internal_error", 502, request, {
      cause: err,
      detail: "Failed to persist the user.",
      requestId: grant.requestId,
    });
  }
  const { appUser, membership } = stored;

  await auditUserAction("admin.user.created", "success", {
    request,
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: appUser.id,
    organizationId: actingOrganizationId(grant.caller.access),
    email: appUser.primary_email,
    requestId: grant.requestId,
    metadata: { betterAuthUserId, via: "api.v1", initialAppStatus: appUser.status },
  });
  if (membership) {
    await auditCreationMembership(membership, {
      request,
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: appUser.id,
      status: appUser.status,
      requestId: grant.requestId,
      metadata: { via: "api.v1" },
    });
  }

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
});
