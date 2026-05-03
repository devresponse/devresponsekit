import "server-only";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { adminErrorResponse } from "@/lib/admin/errors.server";

/**
 * Shared helpers for the `/api/administrator/users/[id]/*` routes.
 *
 * Centralizes the "look up the target user by id, return 404 if
 * missing" pattern so each per-action endpoint stays declarative and
 * the 404 response shape is uniform.
 */
export interface ResolvedTargetUser {
  appUserId: string;
  betterAuthUserId: string;
  primaryEmail: string;
  displayName: string | null;
  status: string;
}

/**
 * RFC 4122-shaped UUID regex. Exported so RSC pages and other helpers
 * (`page.tsx` for the user detail route, etc.) share a single source
 * of truth — duplicating this in multiple places would risk subtle
 * drift if we ever needed to widen / tighten the pattern.
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Resolve the target `app_users` row by primary key. Returns either the
 * resolved row or a ready-to-return `NextResponse` for 404 / 400.
 *
 * - `id` validation accepts only UUIDs to avoid pivoting to other
 *   columns or surfacing 500s from the DB layer when callers pass raw
 *   strings.
 * - The optional `request` argument lets the produced error envelopes
 *   carry the standard `{message, requestId}` fields and the matching
 *   `x-request-id` header (docs/admin-manager.md §5.1, §12). All admin
 *   route handlers pass it; tests and legacy callers may omit it, in
 *   which case a fresh request id is minted for the error envelope.
 */
export async function resolveTargetUser(
  id: string,
  request?: { headers: Headers },
): Promise<ResolvedTargetUser | NextResponse> {
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }
  const row = await db
    .selectFrom("app_users")
    .select([
      "id",
      "better_auth_user_id",
      "primary_email",
      "display_name",
      "status",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) {
    return adminErrorResponse("not_found", 404, request);
  }
  return {
    appUserId: row.id,
    betterAuthUserId: row.better_auth_user_id,
    primaryEmail: row.primary_email,
    displayName: row.display_name,
    status: row.status,
  };
}

export function isResolvedUserResponse(
  value: ResolvedTargetUser | NextResponse,
): value is NextResponse {
  return value instanceof NextResponse;
}
