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
 * Distinct permission keys a user currently HOLDS in ANY organization they are
 * an ACTIVE member of — the UNION of {@link permissionKeysHeldInOrg} over every
 * such org, in one pair of statements instead of N.
 *
 * IMP-1. The impersonate route's escalation guard used to evaluate the target
 * in a SINGLE org — the actor's active one — which was sound only while an
 * impersonated session was believed to be tenant-confined. It was not (the
 * `active_org` cookie is unsigned and the session names the TARGET), so a
 * target who holds nothing in the actor's org but is an admin elsewhere passed
 * the guard and the borrowed session could then be pivoted into that tenant.
 * The guard now compares against this union, so impersonation is refused up
 * front whenever the target holds ANYTHING the actor lacks ANYWHERE. Together
 * with the tenancy confinement in `getUserAccessContext` that is belt and
 * braces: the union stops the impersonation starting, the confinement stops a
 * pivot afterwards.
 *
 * The union is deliberately the STRICTER of the two rules — it refuses even
 * when the target's extra authority sits in a tenant the confinement would
 * already have made unreachable. That is the route's own documented intent,
 * and it fails in the safe direction: the cost is that a non-superadmin org
 * admin cannot impersonate someone who administers an unrelated tenant, and
 * the remedy (a superadmin does it) is already the escape hatch for every
 * other rank refusal here.
 *
 * As with {@link permissionKeysHeldInOrg}, the bare `superuser` MARKER is
 * returned unexpanded: an actor who is not a superadmin does not hold the
 * marker either, so its mere presence already trips the subset test.
 *
 * IMP-2 — NOT SUFFICIENT ON ITS OWN, and NOT redundant either. It is not
 * sufficient because the union is compared against the actor's authority in
 * ONE org (their active one), so an actor who is an admin in A and a
 * role-less member of B passes it against a target who is an admin in B —
 * two different axes that never intersect. {@link permissionKeysByActiveOrg}
 * adds the per-tenant comparison that closes that.
 *
 * It is not redundant because the per-tenant rule deliberately says nothing
 * about a tenant the actor does not belong to, and one such target is
 * catastrophic: `getUserAccessContext` expands the `superuser` marker for the
 * PRINCIPAL (`userIsGlobalSuperuser` spans every org), so borrowing a session
 * from a global superuser yields `hasCrossOrgReach` and `{ kind: "all" }`
 * scope NO MATTER which single tenant the confinement pinned the session to.
 * This union is what refuses that impersonation up front, because the bare
 * marker appears in it wherever the target holds it. Do not replace it with
 * the per-org rule.
 */
export async function permissionKeysHeldInAnyOrg(appUserId: string): Promise<string[]> {
  // Both halves require an ACTIVE membership in the org that confers the role,
  // mirroring `permissionKeysHeldInOrg`: a role left attached in a tenant the
  // user is suspended from grants nothing there and must not count here.
  //
  // The ORGANIZATION'S status is deliberately NOT filtered (F-09), unlike every
  // access-resolving query. This is a rank test, and the stricter one: a
  // tenant suspended now can be reactivated while the borrowed session is
  // still alive, and its grants (a bare `superuser` marker included) come back
  // with it. So they keep counting here.
  const directPerms = db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_organization_memberships as m", (join) =>
      join
        .onRef("m.app_user_id", "=", "ur.app_user_id")
        .onRef("m.organization_id", "=", "ur.organization_id")
        .on("m.status", "=", "active"),
    )
    .innerJoin("app_role_permissions as rp", "rp.role_id", "ur.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.key as key")
    .where("ur.app_user_id", "=", appUserId);
  const groupPerms = db
    .selectFrom("app_group_memberships as gm")
    .innerJoin("app_groups as g", "g.id", "gm.group_id")
    .innerJoin("app_organization_memberships as m", (join) =>
      join
        .onRef("m.app_user_id", "=", "gm.app_user_id")
        .onRef("m.organization_id", "=", "g.organization_id")
        .on("m.status", "=", "active"),
    )
    .innerJoin("app_group_roles as gr", "gr.group_id", "g.id")
    .innerJoin("app_role_permissions as rp", "rp.role_id", "gr.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.key as key")
    .where("gm.app_user_id", "=", appUserId);
  const rows = await directPerms.union(groupPerms).execute();
  return [...new Set(rows.map((r) => r.key))];
}

/**
 * The permission keys a user holds IN EACH organization they are an ACTIVE
 * member of, keyed by organization id.
 *
 * IMP-2. {@link permissionKeysHeldInAnyOrg} flattens authority across tenants,
 * which answers "does the target hold anything the actor lacks ANYWHERE" but
 * cannot answer "does the target OUTRANK the actor IN THIS TENANT" — and that
 * second question is the one the impersonation tenant confinement leaves open.
 * The confinement caps which orgs a borrowed session may resolve (the ones the
 * impersonator belongs to); it says nothing about RANK inside them. So an
 * actor who is an admin in org A and an ordinary member of org B could borrow
 * a session from a target who is a plain member of A and an ADMIN of B: the
 * union test passes (the actor's org-A permissions are a superset of the
 * target's total), the confinement admits B (the actor IS a member), and the
 * borrowed session wields admin authority in B that the actor does not hold
 * there as themselves. Comparing tenant by tenant is what closes that.
 *
 * AN ORG WITH NO ROLES MAPS TO AN EMPTY SET, NOT TO A MISSING KEY. That
 * distinction is the whole point: "an active member holding no authority" and
 * "not a member at all" must lead to OPPOSITE answers in the rank comparison —
 * the first is a shared tenant where the target may hold nothing the actor
 * lacks, the second is a tenant the confinement already makes unreachable and
 * which must therefore not be judged here. Seeding the map from the membership
 * rows is what keeps them apart; deriving the keys from the role rows alone
 * would silently drop every no-role membership and re-open the pivot above.
 *
 * The membership seed carries the `status = 'active'` filter (mirroring
 * {@link permissionKeysHeldInOrg}), so the permission statements below need no
 * membership join of their own: a role left attached in a tenant the user is
 * suspended from lands on an org that is not in the map and is dropped. The
 * ORGANIZATION'S status is not filtered, for the reason given on
 * {@link permissionKeysHeldInAnyOrg} (F-09): a shared tenant that is
 * suspended today is still compared, since it can be reactivated mid-session.
 *
 * Does NOT expand the `superuser` marker into the full catalog — same contract
 * as its two siblings, and for the same reason: callers short-circuit on
 * `hasCrossOrgReach` / `userIsGlobalSuperuser` before comparing ranks, and an
 * actor who is not a superadmin does not hold the bare marker either, so its
 * mere presence on the target's side already trips the subset test.
 */
export async function permissionKeysByActiveOrg(
  appUserId: string,
): Promise<Map<string, Set<string>>> {
  const memberships = await db
    .selectFrom("app_organization_memberships")
    .select("organization_id")
    .where("app_user_id", "=", appUserId)
    .where("status", "=", "active")
    .execute();

  const byOrg = new Map<string, Set<string>>();
  for (const row of memberships) byOrg.set(row.organization_id, new Set());
  // No active membership anywhere → no tenant to compare in, and an empty
  // `in ()` never reaches SQL.
  if (byOrg.size === 0) return byOrg;

  const directPerms = db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_role_permissions as rp", "rp.role_id", "ur.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select(["ur.organization_id as organization_id", "p.key as key"])
    .where("ur.app_user_id", "=", appUserId);
  const groupPerms = db
    .selectFrom("app_group_memberships as gm")
    .innerJoin("app_groups as g", "g.id", "gm.group_id")
    .innerJoin("app_group_roles as gr", "gr.group_id", "g.id")
    .innerJoin("app_role_permissions as rp", "rp.role_id", "gr.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select(["g.organization_id as organization_id", "p.key as key"])
    .where("gm.app_user_id", "=", appUserId);
  const rows = await directPerms.union(groupPerms).execute();
  // `?.add` rather than an upsert: a key whose org is absent from the seed is
  // a role in a tenant this user is not an ACTIVE member of, which grants
  // nothing there and must not create an entry.
  for (const row of rows) byOrg.get(row.organization_id)?.add(row.key);
  return byOrg;
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
