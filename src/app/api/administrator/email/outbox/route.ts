import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";

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
 * Caller MUST hold `admin.email.read`. Bodies are returned for the
 * detail view — they may embed one-time reset links, which is the same
 * exposure as any provider dashboard; access is admin-gated and the
 * links are single-use and short-lived.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.email.read");
  if (isAdminPermissionDenial(guard)) return guard.response;
  // ADR-0001: the outbox is a platform-wide email log with no tenant column
  // — it exposes every org's recipient addresses and bodies. Confine it to
  // SUPERADMIN even though the org-admin-tier `admin.platform` role holds
  // `admin.email.read`.
  if (!isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["created_at", "status", "to_email", "template_key"],
    allowedFilters: ["status", "template_key"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  let base = db.selectFrom("app_outbox as o");

  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    base = base.where("o.status", "=", statusFilter);
  }

  const templateFilter = query.filters.template_key;
  if (typeof templateFilter === "string" && templateFilter.length > 0) {
    base = base.where("o.template_key", "=", templateFilter);
  }

  if (query.q) {
    const like = `%${query.q}%`;
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
