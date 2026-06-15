import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
  isAllowedEnterpriseOrigin,
  isHttpsOrigin,
} from "@/lib/admin/enterprise-apps.server";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, isSuperadmin, resolveOrgScope } from "@/lib/admin/access-scope.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/enterprise-apps
 *
 * Paginated list of `app_enterprise_applications` rows. Returns the
 * uniform `ListResponse` envelope from §5.1.
 *
 * Filters:
 *   - `status` — application status string
 *   - `organization_id` — UUID of the org scope (or `"null"` for global)
 *
 * `q` matches case-insensitively against `id`, `label`, and `subdomain`.
 *
 * Caller MUST hold `admin.apps.read`.
 */
export async function GET(request: NextRequest) {
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

  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    base = base.where("a.status", "=", statusFilter);
  }

  const orgFilter = query.filters.organization_id;
  if (typeof orgFilter === "string" && orgFilter.length > 0) {
    if (orgFilter === "null") {
      base = base.where("a.organization_id", "is", null);
    } else {
      base = base.where("a.organization_id", "=", orgFilter);
    }
  }

  if (query.q) {
    const like = `%${query.q}%`;
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

  const [items, totalRow] = await Promise.all([
    itemsQuery.execute(),
    base.select(sql<string>`count(*)`.as("total")).executeTakeFirst(),
  ]);

  const total = Number(totalRow?.total ?? 0);
  return NextResponse.json(buildListResponse(items, total, query));
}

/**
 * POST /api/administrator/enterprise-apps
 *
 * Creates a new enterprise application. Caller MUST hold
 * `admin.apps.manage`.
 *
 * Body fields:
 *   - id: text, app id (lowercase, hyphens/dots/underscores)
 *   - label: text, human-readable label
 *   - description: optional text
 *   - origin: HTTPS origin (scheme + authority only, §8.10)
 *   - subdomain: hostname-safe DNS label (§8.10)
 *   - sso_audience: text
 *   - status: "available" | "disabled" (default "available")
 *   - sort_order: integer (default 100)
 *   - organization_id: optional UUID scope (null = global)
 */
const createSchema = z
  .object({
    id: z.string().min(1).max(128).regex(APP_ID_RE),
    label: z.string().min(1).max(200),
    description: z.string().max(1000).nullable().optional(),
    origin: z.string().min(1).max(500),
    subdomain: z.string().min(1).max(63).regex(SUBDOMAIN_RE),
    sso_audience: z.string().min(1).max(200).regex(SSO_AUDIENCE_RE),
    status: z.enum(APP_STATUS_VALUES).optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    organization_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.apps.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apps.create",
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
  const input = parsed.data;

  // ADR-0001: an org admin may create an app ONLY in their own org — never
  // a global app and never another org's. SUPERADMIN bypasses.
  const targetOrg = input.organization_id ?? null;
  if (
    !isSuperadmin(guard.access) &&
    (targetOrg === null || !canAccessOrg(guard.access, targetOrg))
  ) {
    return adminErrorResponse("forbidden", 403, request);
  }

  if (!isHttpsOrigin(input.origin)) {
    return adminErrorResponse("invalid_origin", 400, request);
  }
  // P2-5: the origin drives the SSO handoff redirect target — confine it to
  // the trusted host allow-list, not any HTTPS URL.
  if (!isAllowedEnterpriseOrigin(input.origin)) {
    return adminErrorResponse("origin_not_allowed", 400, request);
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
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("id_taken", 409, request);
    }
    if (/foreign key/i.test(message)) {
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
}
