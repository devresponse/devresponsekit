import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { canAccessOrg, resolveOrgScope } from "@/lib/admin/access-scope.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const idSchema = z.uuid();

/**
 * GET /api/administrator/email/outbox/[id]
 *
 * One outbox row WITH its rendered bodies — the detail view behind the
 * metadata-only list (review #221). Caller MUST hold `admin.email.read`.
 *
 * ADR-0001: org-scoped exactly like the list. An ORG ADMIN can only read a
 * row owned by their org; a row in another tenant (or an org-less platform
 * row) answers 404 — never 403 — so its existence is not confirmed. An admin
 * with no resolvable org reads nothing.
 *
 * `body_html` / `body_text` are the REDACTED rendering written at insert
 * time (review #21): reset / verification / invitation tokens were replaced
 * by `[redacted]` before the row was stored, so this endpoint can never hand
 * an org admin a live credential link. The unredacted `delivery_payload`
 * column (retry-worker only) and `variables` are deliberately NOT selected.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.email.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) {
    return adminErrorResponse("not_found", 404, request);
  }

  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return adminErrorResponse("not_found", 404, request);
  }

  let query = db
    .selectFrom("app_outbox as o")
    .leftJoin("app_organizations as org", "org.id", "o.organization_id")
    .select([
      "o.id",
      "o.organization_id",
      "org.slug as organization_slug",
      "org.name as organization_name",
      "o.template_key",
      "o.to_email",
      "o.from_email",
      "o.subject",
      "o.body_html",
      "o.body_text",
      "o.status",
      "o.provider",
      "o.provider_message_id",
      "o.error",
      "o.related_better_auth_user_id",
      "o.created_at",
      "o.sent_at",
    ])
    .where("o.id", "=", id);
  if (scope.kind === "org") {
    query = query.where("o.organization_id", "=", scope.organizationId);
  }

  const row = await query.executeTakeFirst();
  // The WHERE clause already confines an ORG ADMIN to their org; the explicit
  // check is defence-in-depth (and what the contract suites pin).
  if (!row || !canAccessOrg(guard.access, row.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }
  return NextResponse.json(row);
}
