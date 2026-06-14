import "server-only";
import { db } from "@/db/database";
import type { UserAccessContext } from "@/lib/auth-status";

/**
 * Three-tier access control — the core security context
 * (docs/adr/0001-three-tier-access-control.md).
 *
 *   SUPERADMIN — holds the `superuser` marker; manages EVERY organization.
 *                Org scoping is bypassed.
 *   ORG ADMIN  — holds `admin.*` permissions but NOT `superuser`; manages
 *                exactly ONE organization (their membership org). Every
 *                tenant-data query is confined to that org.
 *   USER       — no `admin.*` permission; self-service only.
 *
 * This module is the single source of truth for "which organization may
 * this caller act on". Every administrator / `/api/v1/admin` data query
 * MUST derive its org boundary from here so the rule cannot drift.
 *
 * Design decision (ADR-0001): an org admin belongs to exactly ONE
 * organization, so their org is unambiguous (`access.organizationId`) and
 * needs no per-request org selector. Cross-org administration is a
 * SUPERADMIN-only capability.
 */

/**
 * The marker permission that elevates a principal to SUPERADMIN. Seeded on
 * the `superuser` role (0001-initial-schema.sql / seed-local). Holding it
 * is the ONLY thing that bypasses org scoping — checked explicitly here
 * rather than relying on "happens to hold every permission".
 */
export const SUPERADMIN_PERMISSION = "superuser";

type AccessLike = Pick<UserAccessContext, "permissions" | "organizationId">;

/** True when the caller is a SUPERADMIN (manages all organizations). */
export function isSuperadmin(access: Pick<UserAccessContext, "permissions">): boolean {
  return access.permissions.includes(SUPERADMIN_PERMISSION);
}

/**
 * The org boundary for a caller:
 *   - SUPERADMIN → `{ kind: "all" }` (no scoping; every org).
 *   - ORG ADMIN  → `{ kind: "org", organizationId }` (their single org).
 *   - `null` when an org admin has no resolvable active org — callers MUST
 *     treat null as "deny / empty result", never as "all".
 */
export type OrgScope = { kind: "all" } | { kind: "org"; organizationId: string };

export function resolveOrgScope(access: AccessLike): OrgScope | null {
  if (isSuperadmin(access)) return { kind: "all" };
  if (!access.organizationId) return null;
  return { kind: "org", organizationId: access.organizationId };
}

/**
 * Whether the caller may act on a single resource owned by
 * `resourceOrgId`. SUPERADMIN: always. ORG ADMIN: only an exact match to
 * their org. A `null` resource org (a global/platform-level resource) is
 * reachable by SUPERADMIN only.
 *
 * Callers should return **404** (not 403) on a false result for `[id]`
 * lookups so a resource's existence in another tenant is not leaked.
 */
export function canAccessOrg(access: AccessLike, resourceOrgId: string | null): boolean {
  if (isSuperadmin(access)) return true;
  if (!access.organizationId) return false;
  return resourceOrgId !== null && resourceOrgId === access.organizationId;
}

/**
 * True when `appUserId` holds an active-or-any membership in
 * `organizationId`. Used to org-scope `app_users` access — a user has no
 * `organization_id` column of its own; its tenant IS its membership.
 */
export async function userHasMembershipInOrg(
  appUserId: string,
  organizationId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("app_organization_memberships")
    .select("id")
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Whether the caller may act on the target `app_users` row. SUPERADMIN
 * always; an org admin only when the target holds a membership in the
 * caller's org. Use for `[id]` user routes — return **404** on false so a
 * user's existence in another tenant is not leaked.
 */
export async function canAccessUser(access: AccessLike, appUserId: string): Promise<boolean> {
  if (isSuperadmin(access)) return true;
  if (!access.organizationId) return false;
  return userHasMembershipInOrg(appUserId, access.organizationId);
}
