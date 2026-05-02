import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import {
  isAdminPermissionDenial,
  requireAdminPermission,
} from "@/lib/admin/permissions.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/organizations/:id/provider-bindings
 *
 * Paginated list of provider bindings for this organization.
 * Filters: `provider`.
 *
 * Caller MUST hold `admin.orgs.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const orgExists = await db
    .selectFrom("app_organizations")
    .select(["id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!orgExists) {
    return NextResponse.json({ error: "organization_not_found" }, { status: 404 });
  }

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["provider", "display_name", "created_at"],
    allowedFilters: ["provider"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_provider_organizations as p")
    .where("p.organization_id", "=", id);

  const providerFilter = query.filters.provider;
  if (typeof providerFilter === "string" && providerFilter.length > 0) {
    base = base.where("p.provider", "=", providerFilter);
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "p.id",
      "p.provider",
      "p.provider_organization_key",
      "p.display_name",
      "p.created_at",
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
 * POST /api/administrator/organizations/:id/provider-bindings
 *
 * Creates a new provider binding for this organization.
 *
 * Body:
 *   - provider: string
 *   - providerOrganizationKey: string
 *   - displayName: string (optional)
 *
 * Caller MUST hold `admin.orgs.update`.
 */
const createBindingSchema = z
  .object({
    provider: z.string().min(1).max(64),
    providerOrganizationKey: z.string().min(1).max(255),
    displayName: z.string().max(200).optional(),
  })
  .strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return NextResponse.json({ error: "organization_not_found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = createBindingSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = parsed.data;

  let inserted: { id: string };
  try {
    inserted = await db
      .insertInto("app_provider_organizations")
      .values({
        organization_id: id,
        provider: input.provider,
        provider_organization_key: input.providerOrganizationKey,
        display_name: input.displayName ?? null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return NextResponse.json({ error: "binding_exists" }, { status: 409 });
    }
    throw err;
  }

  await auditOrgAction("admin.organization.provider_bound", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: id,
    metadata: {
      organizationId: id,
      slug: org.slug,
      provider: input.provider,
      providerOrganizationKey: input.providerOrganizationKey,
      bindingId: inserted.id,
    },
  });

  return NextResponse.json({ ok: true, id: inserted.id }, { status: 201 });
}

/**
 * DELETE /api/administrator/organizations/:id/provider-bindings
 *
 * Removes one or more provider bindings by binding id.
 *
 * Body:
 *   - bindingIds: string[]
 *
 * Caller MUST hold `admin.orgs.update`.
 */
const deleteBindingsSchema = z
  .object({
    bindingIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return NextResponse.json({ error: "organization_not_found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = deleteBindingsSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = parsed.data;

  const bindings = await db
    .selectFrom("app_provider_organizations")
    .select(["id", "provider", "provider_organization_key"])
    .where("organization_id", "=", id)
    .where("id", "in", input.bindingIds)
    .execute();
  if (bindings.length === 0) {
    return NextResponse.json({ error: "binding_not_found" }, { status: 404 });
  }

  await db
    .deleteFrom("app_provider_organizations")
    .where("id", "in", input.bindingIds)
    .where("organization_id", "=", id)
    .execute();

  await auditOrgAction("admin.organization.provider_unbound", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: id,
    metadata: {
      organizationId: id,
      slug: org.slug,
      bindingIds: input.bindingIds,
      bindings: bindings.map((b) => ({ provider: b.provider, key: b.provider_organization_key })),
    },
  });

  return NextResponse.json({ ok: true, removed: bindings.length });
}
