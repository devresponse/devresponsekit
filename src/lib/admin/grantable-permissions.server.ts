import "server-only";
import { db } from "@/db/database";
import { scopesAuthorize } from "@/lib/api-auth/scopes";

/**
 * Privilege-escalation guard helpers (AUTHZ-3).
 *
 * The RBAC invariant: a non-SUPERADMIN admin may never CONFER a permission
 * they do not themselves currently hold — not by attaching it to a role, not
 * by duplicating a role, not by assigning a role to a user, and not by
 * bundling a role into a group. Otherwise an org admin holding only, say,
 * `admin.roles.update` could author a role carrying `admin.users.delete`,
 * assign it to themselves, and escalate.
 *
 * Call sites resolve the permission keys a mutation would CONFER, then reject
 * (403) when {@link unheldPermissionKeys} is non-empty for a non-SUPERADMIN.
 * A SUPERADMIN's held set is the full catalog, so the check is a no-op for
 * them — callers gate on `isSuperadmin(access)` first.
 *
 * BEARER CREDENTIALS (P1-1): `access.permissions` is the OWNER's full held
 * set. A credential's authority is that set INTERSECTED WITH ITS SCOPES, so
 * call sites must confer against {@link conferrablePermissions}, not the raw
 * held set, and must NOT skip the guard just because the owner is a superuser
 * (a superuser-owned but narrowly-scoped key confers only within its scopes).
 * The `isSuperadmin` fast-path stays valid only for cookie sessions
 * (`grantedScopes === null`), which carry the human's full authority.
 *
 * This mirrors the credential-scope guard `ungrantableScopes`
 * (`src/lib/api-auth/scopes.ts`): a credential can never out-scope its minter,
 * and now a role/group bundle can never out-authorize the admin who edits it.
 */

/**
 * Distinct permission keys a group confers via its currently-attached roles
 * (empty when the group has no roles). Group membership grants every member
 * the union of the group's roles' permissions (ADR-0002), so adding a member
 * is a conferral and must pass the same {@link unheldPermissionKeys} guard as
 * attaching a role to the group.
 */
export async function permissionKeysForGroup(groupId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_group_roles as gr")
    .innerJoin("app_role_permissions as rp", "rp.role_id", "gr.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.key as key")
    .where("gr.group_id", "=", groupId)
    .execute();
  return [...new Set(rows.map((r) => r.key))];
}

/** Distinct permission keys conferred by the given roles (empty for `[]`). */
export async function permissionKeysForRoles(roleIds: ReadonlyArray<string>): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const rows = await db
    .selectFrom("app_role_permissions as rp")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.key as key")
    .where("rp.role_id", "in", [...roleIds])
    .execute();
  return [...new Set(rows.map((r) => r.key))];
}

/**
 * Distinct permission keys a user currently HOLDS in one organization —
 * direct roles (`app_user_roles`) ∪ group-conferred roles (ADR-0002), exactly
 * as `getUserAccessContext` resolves them, but additionally requiring an
 * ACTIVE membership in that org (a suspended/blocked member holds nothing
 * there). Returns `[]` for an unknown user or a non-member.
 *
 * Used by deferred conferrals that are consumed later by someone else — an
 * invitation's role is granted on ACCEPT, when the inviter's request-time
 * guard no longer exists — so the grant can be re-checked against the
 * inviter's CURRENT authority (review #6). Does NOT expand the `superuser`
 * marker into the full catalog: callers short-circuit on
 * `userIsGlobalSuperuser` first, as the route guards do with `isSuperadmin`.
 */
export async function permissionKeysHeldInOrg(
  appUserId: string,
  organizationId: string,
): Promise<string[]> {
  const activeMember = await db
    .selectFrom("app_organization_memberships")
    .select("id")
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", organizationId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!activeMember) return [];

  const directPerms = db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_role_permissions as rp", "rp.role_id", "ur.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.key as key")
    .where("ur.app_user_id", "=", appUserId)
    .where("ur.organization_id", "=", organizationId);
  const groupPerms = db
    .selectFrom("app_group_memberships as gm")
    .innerJoin("app_groups as g", "g.id", "gm.group_id")
    .innerJoin("app_group_roles as gr", "gr.group_id", "g.id")
    .innerJoin("app_role_permissions as rp", "rp.role_id", "gr.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.key as key")
    .where("gm.app_user_id", "=", appUserId)
    .where("g.organization_id", "=", organizationId);
  const rows = await directPerms.union(groupPerms).execute();
  return [...new Set(rows.map((r) => r.key))];
}

/**
 * Pure: the requested permission keys the actor may NOT confer — those not in
 * the actor's own held set. Returns `[]` when every requested key is held
 * (i.e. the grant is allowed). Permission keys are concrete catalog keys (no
 * wildcards), so a plain subset test is exact.
 */
export function unheldPermissionKeys(
  heldPermissions: ReadonlyArray<string>,
  requestedKeys: ReadonlyArray<string>,
): string[] {
  const held = new Set(heldPermissions);
  return [...new Set(requestedKeys)].filter((key) => !held.has(key));
}

/**
 * Pure: the permissions the acting credential may actually CONFER (P1-1).
 *
 *   - Cookie session (`grantedScopes === null`): the full held set — the
 *     human's authority, unchanged.
 *   - Bearer credential: the held permissions the credential's scopes
 *     authorize, so a narrowly-scoped key can never confer authority beyond
 *     its scopes even when its owner (or a superuser owner) holds more.
 *
 * Feed the result to {@link unheldPermissionKeys} in place of the raw held set.
 */
export function conferrablePermissions(
  heldPermissions: ReadonlyArray<string>,
  grantedScopes: ReadonlyArray<string> | null,
): string[] {
  if (grantedScopes === null) return [...heldPermissions];
  return heldPermissions.filter((key) => scopesAuthorize(grantedScopes, key));
}
