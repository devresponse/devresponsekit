import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/administrator/email/outbox
 *
 * Read-only paginated view of `app_outbox` (specs.md §35). Every
 * outbound email lands here regardless of delivery outcome, so this is
 * the operator's source of truth for "did the system try to email X".
 *
 * Filters:
 *   - `filter[status]`       — pending | sent | failed | logged
 *   - `filter[template_key]` — exact template key
 *
 * `q` matches case-insensitively against `to_email`, `subject`, and
 * `template_key`.
 *
 * Caller MUST hold `admin.email.read`. ADR-0001: the result is org-scoped —
 * a SUPERADMIN sees every org's mail (and platform/system org-less rows),
 * an ORG ADMIN sees only their own org's rows, and an admin with no
 * resolvable org sees nothing.
 *
 * The list is METADATA ONLY (review #221): bodies are served per row by
 * `GET /api/administrator/email/outbox/[id]`, so a 200-row page no longer
 * ships 200 rendered emails. Those bodies are the REDACTED rendering written
 * at insert time (review #21) — one-time reset / verification / invitation
 * tokens are replaced by `[redacted]` before the row is stored, and the
 * unredacted `delivery_payload` column is never selected by any admin route.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.email.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["created_at", "status", "to_email", "template_key"],
    allowedFilters: ["status", "template_key"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_outbox as o")
    .leftJoin("app_organizations as org", "org.id", "o.organization_id");

  // ADR-0001: confine the log to the caller's org. A SUPERADMIN reads all
  // rows (including org-less platform mail); an ORG ADMIN reads only rows
  // owned by their org; a null scope reads nothing, never "all".
  const scope = resolveOrgScope(guard.access);
  if (!scope) {
    return NextResponse.json(buildListResponse([], 0, query));
  }
  if (scope.kind === "org") {
    base = base.where("o.organization_id", "=", scope.organizationId);
  }

  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    base = base.where("o.status", "=", statusFilter);
  }

  const templateFilter = query.filters.template_key;
  if (typeof templateFilter === "string" && templateFilter.length > 0) {
    base = base.where("o.template_key", "=", templateFilter);
  }

  if (query.q) {
    const like = likeContains(query.q);
    base = base.where((eb) =>
      eb.or([
        eb("o.to_email", "ilike", like),
        eb("o.subject", "ilike", like),
        eb("o.template_key", "ilike", like),
      ]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "o.id",
      "o.organization_id",
      "org.slug as organization_slug",
      "org.name as organization_name",
      "o.template_key",
      "o.to_email",
      "o.from_email",
      "o.subject",
      "o.status",
      "o.provider",
      "o.provider_message_id",
      "o.error",
      "o.related_better_auth_user_id",
      "o.created_at",
      "o.sent_at",
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
