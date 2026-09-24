import "server-only";
import type { NextRequest } from "next/server";
import { isSuperadmin, type AccessLike } from "@/lib/admin/access-scope.server";
import { auditOrgAction, auditUserAction } from "@/lib/admin/audit-helpers.server";
import { SHELL_BASELINE_PERMISSION, SUPERADMIN_PERMISSION } from "@/lib/admin/permissions";
import { isScopeNameable } from "@/lib/api-auth/scopes";

/**
 * F-12 — deleting a membership takes the member's grants in that organization
 * with it.
 *
 * A user's authority in an org is their membership plus the grants that hang
 * off it: their `app_user_roles` rows for that org and their
 * `app_group_memberships` in its groups (ADR-0002). Neither table references
 * the membership (migration 0001) and nothing cascades, so deleting only the
 * membership row left every grant in place, invisibly. Re-adding the user
 * (`POST /organizations/[id]/members`, or an invitation they accept) then
 * revived all of them, `superuser` included, with no conferral check and no
 * audit row: a junior org admin who could never confer those roles got them
 * back to the user by adding a member.
 *
 * Both membership DELETE routes now remove the grants in the SAME transaction
 * as the membership, and treat that removal as the revocation it is:
 *
 *   - REVOKE-2 (last superadmin) is read BEFORE the grant deletes, since the
 *     `memberships` removal shape already covers every assignment in the
 *     (user, org) pair and a read after the delete would find nothing left to
 *     protect;
 *   - REVOKE-1 (conferral symmetry) runs on EXACTLY the rows the deletes
 *     returned, so what is checked is what is removed, even if a grant lands
 *     between the request and the transaction. It leaves out what the
 *     membership itself implies ({@link unheldOnMembershipRemoval}). A refusal
 *     throws {@link MembershipGrantsRefusal} so the grant deletes roll back
 *     with it.
 *
 * The delete statements stay inline in the two handlers: the F-11 invariant
 * scan (`tests/unit/group-revocation-guard-invariant.test.ts`) requires every
 * group-row delete to sit in a route handler beside its conferral guard. This
 * module holds only what the two handlers share: the rows they report, the
 * membership rule of REVOKE-1, the refusal signal and its audit vocabulary,
 * and the audit fan-out.
 *
 * Only grants IN the org being left are touched. `app_user_roles` has no
 * org-less rows (`organization_id` is NOT NULL, even for a global role), so
 * leaving one org never reaches authority held in another, including a
 * `superuser` grant held elsewhere.
 */

/** One `app_user_roles` row a membership delete removed, with its role key. */
export interface RevokedRoleGrant {
  app_user_id: string;
  organization_id: string;
  role_id: string;
  role_key: string;
}

/** One `app_group_memberships` row a membership delete removed. */
export interface RemovedGroupGrant {
  app_user_id: string;
  group_id: string;
  group_key: string;
  organization_id: string;
}

/**
 * Audit vocabulary for a REVOKE-1 refusal of a membership delete. One event
 * type for both routes (the org-centric route writes it as an org row, the
 * user-centric one as a user row), so the audit explorer lists every attempt
 * with a single filter, as `LAST_SUPERADMIN_EVENT` does for REVOKE-2.
 * `metadata.unheldPermissions` names the keys the actor could not confer.
 */
export const MEMBERSHIP_REVOCATION_DENIED_EVENT = "admin.membership.revocation_denied";
export const MEMBERSHIP_REVOCATION_DENIED_REASON = "unheld_permissions";

/**
 * REVOKE-1 for a membership delete: which of the keys the AUTHZ-3 subset test
 * refused still stand once the membership itself is taken into account.
 * `unheld` is `unheldPermissionKeys(conferrablePermissions(...), removed)`.
 * The routes call that pair themselves, because the F-11 invariant scan
 * requires it in the handler. Pure.
 *
 *   - `shell.view` never stands. An active membership IMPLIES it
 *     (`getUserAccessContext`), so deleting the membership, which the route's
 *     own permission authorizes, ends it whatever the grants say. A role or
 *     group conferring it in that org adds nothing to measure. Measured as a
 *     conferral, it made every member holding an ordinary role unremovable by
 *     any bearer credential: every seeded role confers it and no scope can
 *     name it.
 *   - At a browser (`grantedScopes === null`) every other refusal stands,
 *     because the held set is exact.
 *   - For a bearer credential, a refusal of a key some scope CAN name stands:
 *     the credential is bounded by its scopes (P1-1). So does a refusal of the
 *     `superuser` marker. No credential can confer it, so none strips it.
 *   - A key NO scope can name (a custom app key, `audit.view`) would be
 *     refused to every credential if it were measured against scopes, however
 *     the credential was minted. It is bounded by the OWNER's own conferral
 *     authority instead, the bound the rank guard puts on the whole member: a
 *     superadmin owner could confer it, anyone else only if they hold it.
 */
export function unheldOnMembershipRemoval(
  unheld: ReadonlyArray<string>,
  access: Pick<AccessLike, "permissions">,
  grantedScopes: ReadonlyArray<string> | null,
): string[] {
  const ownerIsSuperadmin = isSuperadmin(access);
  return unheld.filter((key) => {
    if (key === SHELL_BASELINE_PERMISSION) return false;
    if (grantedScopes === null) return true;
    if (key === SUPERADMIN_PERMISSION || isScopeNameable(key)) return true;
    return !(ownerIsSuperadmin || access.permissions.includes(key));
  });
}

/**
 * Control-flow signal for a REVOKE-1 refusal raised inside the membership
 * delete transaction, AFTER the grant deletes it measured. Throwing is what
 * rolls those deletes back; the route catches it outside the transaction and
 * answers 403. Shared so `instanceof` matches in both routes.
 */
export class MembershipGrantsRefusal extends Error {
  constructor(readonly unheldPermissions: string[]) {
    super(MEMBERSHIP_REVOCATION_DENIED_REASON);
    this.name = "MembershipGrantsRefusal";
  }
}

/**
 * F-32 — the organization a USER-level membership audit row
 * (`admin.user.membership_*`, and the refusals written beside it) is stamped
 * with: the memberships' org when they all sit in one, else `null`.
 *
 * A membership is an org-owned row, so its org is the tenant the action
 * happened in, whoever acted. One request can name memberships in several
 * orgs only for a superadmin (an org-confined caller's list is filtered to its
 * own org first). That request writes a single user-level row about all of
 * them, so stamping any one tenant would show it the others' membership ids;
 * it stays a platform row, and each tenant still gets its own org-stamped
 * `admin.organization.member_*` twin. Those twins are unchanged and carry no
 * `app_user_id`; the stamped user-level row is what puts the event on the
 * member's Audit tab for their org's admins, so it appears there once. Pure.
 */
export function soleOrganizationId(
  memberships: ReadonlyArray<{ organization_id: string }>,
): string | null {
  const orgs = new Set(memberships.map((m) => m.organization_id));
  return orgs.size === 1 ? [...orgs][0]! : null;
}

/**
 * The ids of the grants one membership took with it, for that membership's
 * own `admin.user.membership_removed` / `admin.organization.members_removed`
 * row. Pure.
 */
export function grantIdsRemovedWith(
  appUserId: string,
  organizationId: string,
  roles: ReadonlyArray<RevokedRoleGrant>,
  groups: ReadonlyArray<RemovedGroupGrant>,
): { revokedRoleIds: string[]; removedGroupIds: string[] } {
  return {
    revokedRoleIds: roles
      .filter((r) => r.app_user_id === appUserId && r.organization_id === organizationId)
      .map((r) => r.role_id),
    removedGroupIds: groups
      .filter((g) => g.app_user_id === appUserId && g.organization_id === organizationId)
      .map((g) => g.group_id),
  };
}

/**
 * The audit rows for the grants a membership delete removed, written with the
 * SAME event types as the routes that remove them one at a time
 * (`admin.user.role_revoked`, `admin.group.members_removed`) plus
 * `metadata.cause: "membership_removed"`. A reviewer filtering on those events
 * to answer "when did this user lose that role" therefore finds these too.
 * Returns the pending writes for the caller's `Promise.all`.
 */
export function auditRemovedMembershipGrants(input: {
  request: NextRequest | { headers: Headers };
  actorBetterAuthUserId: string;
  requestId?: string;
  roles: ReadonlyArray<RevokedRoleGrant>;
  groups: ReadonlyArray<RemovedGroupGrant>;
}): Promise<void>[] {
  const { request, actorBetterAuthUserId, requestId } = input;
  const roleRows = input.roles.map((r) =>
    auditUserAction("admin.user.role_revoked", "success", {
      request,
      actorBetterAuthUserId,
      appUserId: r.app_user_id,
      // F-32: the revoked assignment's org, as on the single-role revoke.
      organizationId: r.organization_id,
      requestId,
      metadata: {
        roleId: r.role_id,
        roleKey: r.role_key,
        organizationId: r.organization_id,
        cause: "membership_removed",
      },
    }),
  );

  // One row per GROUP, naming every member it lost, as the group routes write it.
  const byGroup = new Map<string, { key: string; organizationId: string; appUserIds: string[] }>();
  for (const g of input.groups) {
    const entry = byGroup.get(g.group_id);
    if (entry) entry.appUserIds.push(g.app_user_id);
    else
      byGroup.set(g.group_id, {
        key: g.group_key,
        organizationId: g.organization_id,
        appUserIds: [g.app_user_id],
      });
  }
  const groupRows = [...byGroup].map(([groupId, g]) =>
    auditOrgAction("admin.group.members_removed", "success", {
      request,
      actorBetterAuthUserId,
      organizationId: g.organizationId,
      requestId,
      metadata: {
        groupId,
        key: g.key,
        appUserIds: g.appUserIds,
        cause: "membership_removed",
      },
    }),
  );

  return [...roleRows, ...groupRows];
}
