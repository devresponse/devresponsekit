import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { isForeignKeyViolation, isUniqueViolation } from "@/db/pg-errors";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/http/errors.server";
import { createEnterpriseAppSchema } from "@/lib/validation/enterprise-apps";
import {
  isAllowedEnterpriseOrigin,
  isHttpsOrigin,
  isOwnSsoApplicationId,
} from "@/lib/admin/enterprise-apps.server";
import {
  isSsoAudienceTaken,
  isSsoAudienceUniqueViolation,
} from "@/lib/admin/enterprise-apps-audience.server";
import { appNamesOutsideOrgNamespace } from "@/lib/admin/enterprise-apps-namespace.server";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  filterValues,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
import { refuseWithoutCrossOrgReach } from "@/lib/admin/refusals.server";
import { canAccessOrg, hasCrossOrgReach, resolveOrgScope } from "@/lib/admin/access-scope.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/enterprise-apps
 *
 * Paginated list of `app_enterprise_applications` rows. Returns the
 * uniform `ListResponse` envelope from §5.1.
 *
 * Filters, each repeatable (any of its values matches, F-74):
 *   - `status` — application status string
 *   - `organization_id` — UUID of the org scope (or `"null"` for global)
 *
 * `q` matches case-insensitively against `id`, `label`, and `subdomain`.
 *
 * Caller MUST hold `admin.apps.read`.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.apps.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: [
      "id",
      "label",
      "subdomain",
      "status",
      "sort_order",
      "created_at",
      "organization_slug",
    ],
    allowedFilters: ["status", "organization_id"],
    uuidFilters: { organization_id: ["null"] },
    defaultSort: [
      { field: "sort_order", direction: "asc" },
      { field: "label", direction: "asc" },
    ],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_enterprise_applications as a")
    .leftJoin("app_organizations as o", "o.id", "a.organization_id");

  // ADR-0001: an org admin lists only apps owned by their org; global apps
  // (organization_id IS NULL) are SUPERADMIN-only. A null scope yields an
  // empty page, never "all".
  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return NextResponse.json(buildListResponse([], 0, query));
  }
  if (scope.kind === "org") {
    base = base.where("a.organization_id", "=", scope.organizationId);
  }

  // F-74: a repeated filter used to be dropped, which listed every app.
  const statuses = filterValues(query, "status");
  if (statuses.length > 0) {
    base = base.where("a.status", "in", statuses);
  }

  const orgValues = filterValues(query, "organization_id");
  if (orgValues.length > 0) {
    const orgIds = orgValues.filter((value) => value !== "null");
    const includeGlobal = orgIds.length < orgValues.length;
    base = base.where((eb) =>
      eb.or([
        ...(includeGlobal ? [eb("a.organization_id", "is", null)] : []),
        ...(orgIds.length > 0 ? [eb("a.organization_id", "in", orgIds)] : []),
      ]),
    );
  }

  if (query.q) {
    const like = likeContains(query.q);
    base = base.where((eb) =>
      eb.or([
        eb("a.id", "ilike", like),
        eb("a.label", "ilike", like),
        eb("a.subdomain", "ilike", like),
      ]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "a.id",
      "a.label",
      "a.description",
      "a.origin",
      "a.subdomain",
      "a.sso_audience",
      "a.status",
      "a.sort_order",
      "a.organization_id",
      "o.slug as organization_slug",
      "a.created_at",
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
 * POST /api/administrator/enterprise-apps
 *
 * Creates a new enterprise application. Caller MUST hold
 * `admin.apps.manage`.
 *
 * Body fields:
 *   - id: text, app id (lowercase, hyphens/dots/underscores); never this
 *     deployment's own `SSO_HANDOFF_APPLICATION_ID` (409 `id_taken`, F-83)
 *   - label: text, human-readable label
 *   - description: optional text
 *   - origin: HTTPS origin (scheme + authority only, §8.7); never this
 *     deployment's own origin (400 `origin_not_allowed`, F-83)
 *   - subdomain: hostname-safe DNS label (§8.7)
 *   - sso_audience: text; MUST be unique across the catalog and differ from
 *     this deployment's own audience (409 `audience_taken`, F-83)
 *   - status: "available" | "disabled" (default "available")
 *   - sort_order: integer (default 100)
 *   - organization_id: optional UUID scope (null = global)
 *
 * A caller without cross-org reach names the app under its org's slug: an id
 * `<slug>.<name>` and an audience whose last `:` segment is such an id, or
 * 403 `forbidden` (I-01).
 */
export const POST = withAdminRoute(async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.apps.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apps.create",
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
  const parsed = createEnterpriseAppSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  // ADR-0001: an org admin may create an app ONLY in their own org — never
  // a global app and never another org's. SUPERADMIN bypasses.
  // MACHINE-2: `hasCrossOrgReach`, not `isSuperadmin` — an ORG-BOUND bearer
  // credential never takes the SUPERADMIN bypass on a platform-wide action,
  // even when its owner is a global superuser.
  const targetOrg = input.organization_id ?? null;
  if (
    !hasCrossOrgReach(guard.access) &&
    (targetOrg === null || !canAccessOrg(guard.access, targetOrg))
  ) {
    return refuseWithoutCrossOrgReach(guard, request, "enterprise_app_create", {
      requestedGlobal: targetOrg === null,
    });
  }
  // I-01: the id and the audience are global names, so an org admin claims
  // only names under its org's slug (`acme.crm`, `devresponse-app:acme.crm`);
  // a global name squatted here would 409 the superadmin who registers the
  // real satellite. (`targetOrg` is never null here: refused above.)
  if (!hasCrossOrgReach(guard.access) && targetOrg !== null) {
    const outside = await appNamesOutsideOrgNamespace(targetOrg, {
      id: input.id,
      sso_audience: input.sso_audience,
    });
    if (outside.length > 0) {
      return refuseWithoutCrossOrgReach(guard, request, "enterprise_app_global_name", {
        applicationId: input.id,
        ssoAudience: input.sso_audience,
      });
    }
  }

  if (!isHttpsOrigin(input.origin)) {
    return adminErrorResponse("invalid_origin", 400, request);
  }
  // P2-5: the origin drives the SSO handoff redirect target — confine it to
  // the trusted host allow-list, not any HTTPS URL. F-83: never this
  // deployment's own origin.
  if (!isAllowedEnterpriseOrigin(input.origin)) {
    return adminErrorResponse("origin_not_allowed", 400, request);
  }
  // F-83: this deployment's own application id is taken by the deployment
  // itself; a row under it would make the primary an SSO target of itself.
  if (isOwnSsoApplicationId(input.id)) {
    return adminErrorResponse("id_taken", 409, request);
  }
  // Review #15: the audience is what a satellite's consume route trusts; two
  // rows sharing one would let a token minted for either app reach the other.
  // F-83: this deployment's own audience counts as taken.
  if (await isSsoAudienceTaken(input.sso_audience)) {
    return adminErrorResponse("audience_taken", 409, request);
  }

  try {
    await db
      .insertInto("app_enterprise_applications")
      .values({
        id: input.id,
        label: input.label,
        description: input.description ?? null,
        origin: input.origin,
        subdomain: input.subdomain,
        sso_audience: input.sso_audience,
        status: input.status ?? "available",
        sort_order: input.sort_order ?? 100,
        organization_id: input.organization_id ?? null,
      })
      .execute();
  } catch (err) {
    // Review #15: the UNIQUE index on sso_audience (migration 0005) closes the
    // race the pre-check above leaves open; its 23505 is an audience
    // collision, so it must NOT be reported as `id_taken`.
    if (isSsoAudienceUniqueViolation(err)) {
      return adminErrorResponse("audience_taken", 409, request);
    }
    // F-132: by SQLSTATE and constraint, never by the (translatable) message.
    if (isUniqueViolation(err, "app_enterprise_applications_pkey")) {
      return adminErrorResponse("id_taken", 409, request);
    }
    if (isForeignKeyViolation(err, "app_enterprise_applications_organization_id_fkey")) {
      return adminErrorResponse("organization_not_found", 409, request);
    }
    throw err;
  }

  await auditEvent({
    eventType: "admin.app.created",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: input.organization_id ?? null,
    targetApplicationId: input.id,
    request,
    metadata: {
      id: input.id,
      label: input.label,
      subdomain: input.subdomain,
      status: input.status ?? "available",
    },
  });

  return NextResponse.json({ ok: true, id: input.id }, { status: 201 });
});
