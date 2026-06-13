import type { NextRequest } from "next/server";
import { db } from "@/db/database";
import { requireApiPermission } from "@/lib/api-auth/v1-guard.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";
import { userEtag } from "@/lib/api-auth/etag";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/users/[id]
 *
 * Reads a single application user (`admin.users.read`). Emits a weak
 * `ETag` derived from `updated_at` so clients can use `If-Match` for
 * optimistic concurrency on subsequent mutations (design §8.1).
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiPermission(request, "admin.users.read");
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);

  const user = await db
    .selectFrom("app_users")
    .select([
      "id",
      "better_auth_user_id",
      "primary_email",
      "display_name",
      "status",
      "status_reason",
      "preferred_locale",
      "created_at",
      "updated_at",
    ])
    .where("id", "=", id)
    .executeTakeFirst();

  if (!user) return problemResponse("not_found", 404, request);

  return v1JsonResponse({ user }, request, {
    headers: { ETag: userEtag(user.updated_at as unknown as Date) },
  });
}
