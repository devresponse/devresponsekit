import "server-only";
import { db } from "@/db/database";

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
