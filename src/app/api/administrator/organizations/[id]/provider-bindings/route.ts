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
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, hasCrossOrgReach } from "@/lib/admin/access-scope.server";
import { auditEvent } from "@/lib/audit.server";
import { isAuthMethod } from "@/lib/auth-policy.server";
import { EMAIL_DOMAIN_RE } from "@/lib/validation/auth-policy";
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
    return adminErrorResponse("invalid_id", 400, request);
  }

  const orgExists = await db
    .selectFrom("app_organizations")
    .select(["id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!orgExists) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  // ADR-0001: org admins are confined to their own org; 404 (not 403) so a
  // foreign org's existence is not confirmed. SUPERADMIN bypasses.
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["provider", "display_name", "created_at", "provider_organization_key"],
    allowedFilters: ["provider"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db.selectFrom("app_provider_organizations as p").where("p.organization_id", "=", id);

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

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  return NextResponse.json(buildListResponse(items, total, query));
}

/**
 * Consumer mailbox providers (a curated list, not an exhaustive one — it
 * guards against an operator mistake; only a superadmin can bind at all).
 * Binding one would route every uninvited sign-up from millions of unrelated
 * people into a single tenant, so no one may bind these (F-04).
 */
const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "zoho.com",
  "qq.com",
  "163.com",
  "126.com",
  "hey.com",
  "fastmail.com",
  "tutanota.com",
  // Regional twins of the above, and the large ISP mailboxes in this
  // product's first markets.
  "hotmail.ca",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.ca",
  "live.co.uk",
  "outlook.fr",
  "yahoo.ca",
  "yahoo.co.uk",
  "yahoo.fr",
  "yahoo.co.jp",
  "rocketmail.com",
  "aim.com",
  "gmx.at",
  "t-online.de",
  "naver.com",
  "comcast.net",
  "shaw.ca",
  "rogers.com",
  "sympatico.ca",
  "telus.net",
  "videotron.ca",
]);

/**
 * Normalizes a binding key the way its consumer will look it up, or returns
 * the reason it cannot be bound. An `email` key is the email DOMAIN
 * (`findEmailDomainOrganization` lowercases the sign-up's domain), so it is
 * lowercased and must be a real, non-consumer domain; before this, a
 * mixed-case key was stored and silently never matched.
 */
function normalizeBindingKey(
  provider: string,
  rawKey: string,
): { ok: true; key: string } | { ok: false; reason: string } {
  const key = rawKey.trim();
  if (key.length === 0) return { ok: false, reason: "invalid_key" };
  if (provider !== "email") return { ok: true, key };
  const domain = key.toLowerCase();
  if (!EMAIL_DOMAIN_RE.test(domain)) return { ok: false, reason: "invalid_email_domain" };
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) return { ok: false, reason: "public_email_domain" };
  return { ok: true, key: domain };
}

/**
 * POST /api/administrator/organizations/:id/provider-bindings
 *
 * Creates a new provider binding for this organization.
 *
 * Body:
 *   - provider: one of the auth methods (`email`, `google`, `microsoft`, `github`)
 *   - providerOrganizationKey: string (for `email`, the email domain)
 *   - displayName: string (optional)
 *
 * Caller MUST hold `admin.orgs.update` AND have cross-org reach (an unbound
 * superadmin) — F-04. A binding is a PLATFORM-WIDE claim, not a setting of
 * one tenant: `(provider, key)` is unique across every organization, and an
 * `email` binding routes every uninvited email/password sign-up from that
 * domain into this organization, under this organization's admins. An org
 * admin who could bind `gmail.com` — or a competitor's `acme.com` — captured
 * strangers into their tenant (and, with `auto_active`, as active members
 * they could then administer) and squatted the domain from its real owner;
 * the 409 on a collision also told them which domains other tenants held.
 * Org admins may still READ and REMOVE their own organization's bindings.
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

  const limited = enforceRateLimit(
    "admin.orgs.bindings",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  // F-04 — a binding is a platform-wide claim; only cross-org reach may make
  // one. Checked after the tenant check so a foreign org still answers 404.
  if (!hasCrossOrgReach(guard.access)) {
    await auditEvent({
      eventType: "admin.organization.provider_bind_denied",
      outcome: "denied",
      // The human behind an impersonated session, as the F-02 refusals record.
      actorBetterAuthUserId: guard.impersonatorId ?? guard.betterAuthUserId,
      organizationId: id,
      reason: "cross_org_reach_required",
      request,
      requestId: guard.requestId,
    });
    return adminErrorResponse("forbidden", 403, request, {
      requestId: guard.requestId,
      extra: { reason: "cross_org_reach_required" },
    });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = createBindingSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;
  if (!isAuthMethod(input.provider)) {
    return adminErrorResponse("invalid_body", 400, request, {
      extra: { reason: "unknown_provider" },
    });
  }
  const normalized = normalizeBindingKey(input.provider, input.providerOrganizationKey);
  if (!normalized.ok) {
    return adminErrorResponse("invalid_body", 400, request, {
      extra: { reason: normalized.reason },
    });
  }

  let inserted: { id: string };
  try {
    inserted = await db
      .insertInto("app_provider_organizations")
      .values({
        organization_id: id,
        provider: input.provider,
        provider_organization_key: normalized.key,
        display_name: input.displayName ?? null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("binding_exists", 409, request);
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
      providerOrganizationKey: normalized.key,
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

  const limited = enforceRateLimit(
    "admin.orgs.bindings",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = deleteBindingsSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const bindings = await db
    .selectFrom("app_provider_organizations")
    .select(["id", "provider", "provider_organization_key"])
    .where("organization_id", "=", id)
    .where("id", "in", input.bindingIds)
    .execute();
  if (bindings.length === 0) {
    return adminErrorResponse("binding_not_found", 404, request);
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
