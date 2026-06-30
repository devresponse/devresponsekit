import "server-only";
import { db } from "@/db/database";
import { SUPERADMIN_PERMISSION } from "@/lib/admin/permissions";
import type { UserAccessContext } from "@/lib/auth-status";

/**
 * Three-tier access control — the core security context
 * (docs/architecture.md — Access-control design decisions).
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
 * Re-exported from the neutral catalog module (single source of truth).
 * Holding this marker is the ONLY thing that bypasses org scoping — checked
 * explicitly via {@link isSuperadmin} rather than relying on "happens to hold
 * every permission".
 */
export { SUPERADMIN_PERMISSION };

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

/**
 * True when `appUserId` holds a membership in ANY organization OTHER than
 * `organizationId` — i.e. the user is shared across tenants. Used to decide
 * whether a non-SUPERADMIN's lifecycle action would reach outside their org
 * (AUTHZ-1/2): a single-org user can be managed account-globally, but a
 * shared user must be confined to the actor's org.
 */
export async function userHasMembershipOutsideOrg(
  appUserId: string,
  organizationId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("app_organization_memberships")
    .select("id")
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "!=", organizationId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Whether an ACCOUNT-GLOBAL action (Better Auth ban/unban, soft-delete/
 * restore — actions that lock a user out of, or back into, EVERY org) is
 * forbidden for this actor against this target (AUTHZ-2).
 *
 * A SUPERADMIN may always act account-globally. A non-SUPERADMIN may only do
 * so when the target is NOT shared with other orgs — otherwise the action
 * would change the user's access in tenants the actor does not administer, so
 * it is reserved for a SUPERADMIN (the caller returns 403).
 */
export async function requiresSuperadminForSharedTarget(
  scope: OrgScope,
  appUserId: string,
): Promise<boolean> {
  if (scope.kind === "all") return false;
  return userHasMembershipOutsideOrg(appUserId, scope.organizationId);
}

/**
 * Whether the user holds the {@link SUPERADMIN_PERMISSION} marker via a role
 * in ANY organization they are an ACTIVE member of — i.e. whether they are a
 * superadmin regardless of which org is currently active.
 *
 * This is the GLOBAL superuser determination that makes "superuser = all
 * orgs, always" a hard invariant: `getUserAccessContext` calls it so the
 * active-org selector can never downgrade a superadmin. The active-membership
 * join ensures a suspended/blocked membership cannot confer the marker.
 */
export async function userIsGlobalSuperuser(appUserId: string): Promise<boolean> {
  const row = await db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_organization_memberships as m", (join) =>
      join
        .onRef("m.app_user_id", "=", "ur.app_user_id")
        .onRef("m.organization_id", "=", "ur.organization_id")
        .on("m.status", "=", "active"),
    )
    .innerJoin("app_role_permissions as rp", "rp.role_id", "ur.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.id")
    .where("ur.app_user_id", "=", appUserId)
    .where("p.key", "=", SUPERADMIN_PERMISSION)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
