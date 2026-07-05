import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/database";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isUuid } from "@/lib/admin/user-target.server";
import type { UserAccessContext } from "@/lib/auth-status";

export interface ScopedOrg {
  id: string;
  slug: string;
  name: string;
}

/**
 * Loads an organization for an `/administrator/organizations/:id/*` sub-route
 * and enforces ADR-0001 tenant scoping in one place, replacing the copy of
 * this logic that lived in every such route (auth-settings, invitations,
 * invitation revoke/resend).
 *
 *   - malformed id           → `invalid_id` (400)
 *   - missing OR out-of-scope → `organization_not_found` (404)
 *
 * A foreign org returns 404 (not 403) so its existence is never confirmed;
 * SUPERADMIN bypasses the scope check. Returns the org row (`id`, `slug`,
 * `name` — the superset every caller needs) or a ready-to-return error
 * `NextResponse`, so callers keep the `if (org instanceof NextResponse)
 * return org;` shape and the exact machine codes.
 */
export async function loadScopedOrg(
  request: NextRequest,
  orgId: string,
  access: Pick<UserAccessContext, "permissions" | "organizationId">,
): Promise<ScopedOrg | NextResponse> {
  if (!isUuid(orgId)) {
    return adminErrorResponse("invalid_id", 400, request);
  }
  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug", "name"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  if (!canAccessOrg(access, orgId)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  return org;
}
