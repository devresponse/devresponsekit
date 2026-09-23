import "server-only";
import type { Kysely } from "kysely";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import { SUPERADMIN_PERMISSION } from "@/lib/admin/permissions";
import type { UserAccessContext } from "@/lib/auth-status";
import { ACTIVE_ORGANIZATION_STATUS } from "@/lib/validation/organizations";

/**
 * Three-tier access control — the core security context
 * (docs/architecture.md — Access-control design decisions).
 *
 *   SUPERADMIN — holds the `superuser` marker; manages EVERY organization.
 *                Org scoping is bypassed.
 *   ORG ADMIN  — holds `admin.*` permissions but NOT `superuser`; manages
 *                ONE organization per request — the ACTIVE org resolved by
 *                `getUserAccessContext`. Every tenant-data query is
 *                confined to that org.
 *   USER       — no `admin.*` permission; self-service only.
 *
 * This module is the single source of truth for "which organization may
 * this caller act on". Every administrator / `/api/v1/admin` data query
 * MUST derive its org boundary from here so the rule cannot drift.
 *
 * Design decision (ADR-0001): an org admin's scope is the ACTIVE
 * organization as resolved by `getUserAccessContext` — a user may hold
 * several memberships, and the active one is selected per request by the
 * `active_org` cookie (earliest membership as the fallback); bearer
 * credentials are pinned to the org they were minted for and never read the
 * cookie (MACHINE-1). Every tenant query derives from `access.organizationId`;
 * acting on any OTHER org requires switching the active org. Cross-org
 * administration (several orgs in one request) is a SUPERADMIN-only
 * capability. (review #30)
 *
 * MACHINE-2 (bound reach) — the SUPERADMIN bypass above is a HUMAN-session
 * capability. MACHINE-1 promises that "a credential always acts in its minted
 * tenant", but that promise was only half-kept: the resolver pinned WHICH
 * membership the credential resolves against, while `getUserAccessContext`
 * still expands a global superuser principal to the full superuser permission
 * set on the bound-org path (correctly — see the comment there), and the
 * `isSuperadmin` bypass below then answered "all orgs". A credential minted in
 * org A whose OWNER happens to be a global superuser therefore reached EVERY
 * tenant — and an org admin holding `admin.apikeys.manage` could mint exactly
 * such a credential on behalf of any superuser co-member (support staff in a
 * customer tenant, or the seeded default admin), pocket the one-time
 * plaintext, and read or mutate the whole platform.
 *
 * So the bypass is now qualified by {@link hasCrossOrgReach}: an ORG-BOUND
 * context (`access.orgBound === true`, set by `getUserAccessContext` whenever
 * a `boundOrg` argument was supplied) is confined to `access.organizationId`
 * exactly like an org admin, and to NOTHING when it has no resolvable org (see
 * {@link resolveOrgScope} for what an ORG-LESS credential — one minted with a
 * null `organization_id` — resolves to; it is pinned, not denied).
 * Cookie sessions are untouched — a superadmin at a browser still manages
 * every tenant. Note that this is a scoping rule, not an identity rule:
 * {@link isSuperadmin} keeps answering "is this principal a superadmin?"
 * truthfully, because the permission set really is the superuser's; only the
 * REACH is capped.
 */

/**
 * Re-exported from the neutral catalog module (single source of truth).
 * Holding this marker is the ONLY thing that bypasses org scoping — checked
 * explicitly via {@link isSuperadmin} rather than relying on "happens to hold
 * every permission".
 */
export { SUPERADMIN_PERMISSION };

/**
 * The slice of {@link UserAccessContext} every scoping decision needs.
 * Exported so the helpers that forward an access context (`loadScopedOrg`,
 * `resolveTargetUser`, `selectDashboardMetrics`, …) can declare the SAME
 * slice instead of re-`Pick`ing a narrower one — a narrower Pick would drop
 * `orgBound` from the type and let a future refactor silently strip the
 * MACHINE-2 marker on the way in. `orgBound` is optional, so every existing
 * literal still satisfies it.
 */
export type AccessLike = Pick<UserAccessContext, "permissions" | "organizationId" | "orgBound">;

/**
 * True when the caller is a SUPERADMIN (holds the `superuser` marker).
 *
 * This is an IDENTITY question and its meaning is deliberately unchanged: it
 * answers "is this principal a superadmin", not "may this request reach every
 * org". For the latter — the only question a tenant boundary should ever ask
 * — use {@link hasCrossOrgReach}, which additionally refuses the bypass to an
 * org-bound machine credential (MACHINE-2).
 */
export function isSuperadmin(access: Pick<UserAccessContext, "permissions">): boolean {
  return access.permissions.includes(SUPERADMIN_PERMISSION);
}

/**
 * True when this context came from a BEARER CREDENTIAL bound to one
 * organization (MACHINE-1/MACHINE-2). Absent marker → not bound, which is the
 * pre-existing behaviour for every hand-built context and for cookie sessions.
 */
export function isOrgBound(access: Pick<UserAccessContext, "orgBound">): boolean {
  return access.orgBound === true;
}

/**
 * True when the caller may act BEYOND its own organization — a SUPERADMIN
 * whose authority is not pinned to a single tenant by the credential it is
 * presenting (MACHINE-2).
 *
 * This is the predicate every cross-tenant decision must use. An org-bound
 * credential is capped even when its principal is a global superuser: the
 * credential was minted for ONE tenant, and a one-time plaintext handed to
 * whoever minted it must never be a key to the whole platform.
 */
export function hasCrossOrgReach(
  access: Pick<UserAccessContext, "permissions" | "orgBound">,
): boolean {
  return isSuperadmin(access) && !isOrgBound(access);
}

/**
 * Mint-time reach bound for an ON-BEHALF credential issuance (MACHINE-2,
 * layer 2 — sibling of `targetOutranksActor` in `user-target.server.ts`).
 *
 * All FOUR on-behalf issuance paths — `POST /api/administrator/api-keys`, its
 * `[id]/rotate` twin, `POST /api/v1/admin/oauth-clients` and ITS
 * `[id]/rotate-secret` twin — hand the ACTOR a one-time secret for a
 * credential that authenticates as SOMEONE ELSE. Their existing bounds
 * constrain which SCOPE NAMES may ride along (the owner's held set ∩ the
 * actor's grantable set) but say nothing about the owner's org REACH — so an
 * org admin could mint a credential owned by a superuser co-member using only
 * scopes they themselves hold, and wield it. Layer 1 already confines the
 * resulting credential to its bound org; this refuses the mint outright so the
 * caller gets an explicit 403 instead of a silently narrowed credential.
 *
 * Returns true when the OWNER outranks the ACTOR: the owner ranks as a
 * superuser and the actor does not. A superadmin actor is exempt — they
 * already hold every power, so they confer nothing they lack.
 *
 * `ownerIsSuperadmin` is the owner's RANK, and every caller must compute it
 * with {@link userHoldsSuperuserGrant} (the api-keys POST ORs in the owner's
 * resolved context too, for a group-conferred marker), never with
 * {@link userIsGlobalSuperuser} alone. Since F-09 that is AUTHORITY, which a
 * grant sleeping in a suspended org no longer satisfies; the grant wakes when
 * the org is reactivated, and a credential minted or rotated for its holder in
 * the meantime would then authenticate as a platform superuser.
 * `tests/unit/credential-issuance-invariant.test.ts` scans every caller for it.
 *
 * P1-1 — the actor exemption requires `actorGrantedScopes === null` (a COOKIE
 * session), the same form this codebase writes everywhere else on a
 * bearer-reachable path (see `grantable-permissions.server.ts`, and the seven
 * `isSuperadmin(guard.access) && guard.grantedScopes === null` gates on the
 * role/group routes). `actorAccess.permissions` is the OWNER OF THE
 * CREDENTIAL's full held set, not the credential's authority — a
 * superuser-owned key scoped to only `admin.apikeys.manage` would otherwise be
 * exempt from this bound and could reissue a broadly-scoped superuser-owned
 * key in its bound org, escalating from one scope to whatever that key holds.
 * A bearer credential therefore never mints or rotates on behalf of a superuser
 * principal, whoever owns it; only a human superadmin at a browser may.
 */
export function ownerOutranksActor(
  ownerIsSuperadmin: boolean,
  actorAccess: Pick<UserAccessContext, "permissions">,
  actorGrantedScopes: string[] | null,
): boolean {
  return ownerIsSuperadmin && !(isSuperadmin(actorAccess) && actorGrantedScopes === null);
}

/**
 * The org boundary for a caller:
 *   - SUPERADMIN → `{ kind: "all" }` (no scoping; every org).
 *   - ORG ADMIN  → `{ kind: "org", organizationId }` (their ACTIVE org).
 *   - ORG-BOUND CREDENTIAL → `{ kind: "org", organizationId }` — its bound
 *     org, NEVER `{ kind: "all" }`, even when its owner is a global superuser
 *     (MACHINE-2).
 *   - `null` when an org admin — or an org-bound credential — has no
 *     resolvable org. Callers MUST treat null as "deny / empty result", never
 *     as "all".
 *
 * ORG-LESS CREDENTIALS. "No resolvable org" means `access.organizationId` is
 * null, which is NOT the same as "the credential named no tenant". A
 * credential minted with `organization_id = null` (only an unbound superadmin
 * can create one — `POST /api/v1/admin/oauth-clients` honours a caller-supplied
 * `organizationId` exclusively on the `kind: "all"` branch) still resolves
 * through the bound path, where `getUserAccessContext` falls back to the
 * principal's EARLIEST membership (MACHINE-1, unchanged). It is therefore
 * org-bound to that one membership and scoped to it here. For a NON-superuser
 * owner that is exactly the pre-MACHINE-2 behaviour; for a SUPERUSER owner it
 * is a deliberate narrowing — an org-less credential is not a platform master
 * key either, and pinning it to a membership rather than denying it keeps the
 * two owner kinds on one rule. Operators who need platform-wide machine reach
 * do not have it: use a human superadmin session, or one credential per tenant.
 */
export type OrgScope = { kind: "all" } | { kind: "org"; organizationId: string };

export function resolveOrgScope(access: AccessLike): OrgScope | null {
  // MACHINE-2: only an UNBOUND superadmin (a cookie session) escapes scoping.
  // A bound credential falls through to the org branch below and is therefore
  // confined to `access.organizationId` — and to `null` (deny) when the bound
  // org resolved to no membership, the same fail-closed path an org admin with
  // no active org takes.
  if (hasCrossOrgReach(access)) return { kind: "all" };
  if (!access.organizationId) return null;
  return { kind: "org", organizationId: access.organizationId };
}

/**
 * Whether the caller may act on a single resource owned by
 * `resourceOrgId`. SUPERADMIN: always. ORG ADMIN: only an exact match to
 * their org. A `null` resource org (a global/platform-level resource) is
 * reachable by SUPERADMIN only.
 *
 * MACHINE-2: an ORG-BOUND credential does NOT take the superadmin fast-path —
 * it is held to the exact-match rule against its bound org, so a
 * superuser-owned key minted in org A cannot read or mutate org B's rows, and
 * cannot reach a platform-global (`null`-org) record either.
 *
 * Callers should return **404** (not 403) on a false result for `[id]`
 * lookups so a resource's existence in another tenant is not leaked.
 */
export function canAccessOrg(access: AccessLike, resourceOrgId: string | null): boolean {
  if (hasCrossOrgReach(access)) return true;
  if (!access.organizationId) return false;
  return resourceOrgId !== null && resourceOrgId === access.organizationId;
}

/**
 * True when `appUserId` holds a membership in `organizationId` — of ANY
 * status. Used to org-scope `app_users` access: a user has no
 * `organization_id` column of its own; its tenant IS its membership.
 *
 * The missing `status = 'active'` filter is DELIBERATE, and load-bearing
 * (review #210). A membership row is a TENANT CLAIM, not a grant of access:
 *   - The admin surfaces that need this predicate are precisely the ones that
 *     act on a NON-active member — approve a `pending_approval` signup,
 *     unblock a `blocked` user, reactivate a `suspended` one. Filtering on
 *     `active` would make every such user invisible to their own org's admin
 *     (a 404 on the very page that exists to fix them), and would strand them
 *     permanently: no admin could ever restore an account whose membership is
 *     not already restored.
 *   - It does NOT widen anyone's reach, because a non-active membership is
 *     still confined to ONE org. Whether the TARGET may sign in is decided
 *     elsewhere, by `decideSecureAccess`; whether the CALLER may administer at
 *     all is decided by their own status + permissions in
 *     `requireAdminPermission` / `checkAdminPermissionServer`, which reject a
 *     caller whose own membership is not active before this is ever reached.
 *
 * So: narrowing this to active memberships is a BUG, not a hardening. The
 * intent is pinned by `tests/db/access-scope.db.test.ts` (real rows, every
 * membership status) so a future "fix" fails CI instead of silently changing
 * admin reach in either direction.
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
 *
 * MACHINE-2: an ORG-BOUND credential does NOT take the superadmin fast-path —
 * its targets are the members of its bound org, exactly like an org admin's.
 * This is what keeps `resolveTargetUser` (and therefore every
 * `/administrator/users/[id]/*` action and `/api/v1/users/[id]`) from handing
 * a superuser-owned key another tenant's users.
 *
 * The target's membership STATUS is deliberately not consulted — see
 * {@link userHasMembershipInOrg} for why (review #210): the approve / unblock
 * / reactivate flows exist exactly to act on a non-active member.
 */
export async function canAccessUser(access: AccessLike, appUserId: string): Promise<boolean> {
  if (hasCrossOrgReach(access)) return true;
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
 *
 * MACHINE-2 is inherited rather than re-checked: the `scope` argument comes
 * from {@link resolveOrgScope}, which already refuses `{ kind: "all" }` to an
 * org-bound credential, so a superuser-owned bound key lands in the `org`
 * branch and is correctly refused a shared target.
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
 * orgs, always" a hard invariant for the PRINCIPAL: `getUserAccessContext`
 * calls it so the active-org selector can never downgrade a superadmin. The
 * active-membership join ensures a suspended/blocked membership cannot confer
 * the marker, and the active-ORGANIZATION join (F-09) does the same for a
 * grant held in a tenant that is suspended, archived or still pending: it
 * confers nothing until the org is reactivated. Suspending the org that holds
 * the last such grant is refused by REVOKE-2 (`organizationIds` below), so the
 * platform cannot be suspended into a lockout.
 *
 * MACHINE-2: "all orgs" describes the human, not every credential they own. A
 * request presenting an org-bound credential is capped to that org by
 * {@link hasCrossOrgReach}; this predicate is unchanged by it and still
 * reports the principal's authority whatever credential they present.
 *
 * This answers "is this principal a superadmin NOW" (authority). The rank
 * guards — `targetOutranksActor` and the on-behalf credential bound
 * {@link ownerOutranksActor} — ask a different question; see
 * {@link userHoldsSuperuserGrant}.
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
    .innerJoin("app_organizations as o", (join) =>
      join.onRef("o.id", "=", "m.organization_id").on("o.status", "=", ACTIVE_ORGANIZATION_STATUS),
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

/**
 * Whether the user holds a direct `superuser` grant through an ACTIVE
 * membership, WHATEVER the status of the organization it sits in — the RANK
 * twin of {@link userIsGlobalSuperuser} (F-09).
 *
 * The two differ only while a grant's organization is not active, and they
 * have to. Authority follows the org's status: a superuser whose grant lives
 * in a suspended tenant is not a superadmin today. Rank must not follow it,
 * because the grant comes back the moment an operator reactivates that tenant,
 * without anyone re-conferring it. If the rank guards read authority instead,
 * a delegated admin who shares another, still active tenant with that
 * superuser could, while the grant sleeps, set their password
 * (`targetOutranksActor`) or mint, rotate or register a credential that
 * authenticates as them ({@link ownerOutranksActor}, on all four on-behalf
 * issuance paths), and hold a platform-superadmin login or credential once it
 * wakes. Before F-09 the grant counted for both, so reading it here keeps the
 * rank guards exactly as strict as they were.
 */
export async function userHoldsSuperuserGrant(appUserId: string): Promise<boolean> {
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

/**
 * {@link userIsGlobalSuperuser}, keyed on the BETTER AUTH user id instead of
 * the `app_users` primary key — one statement rather than an id resolution
 * followed by the probe.
 *
 * IMP-2. The only identifier Better Auth's `impersonatedBy` marker carries is
 * the Better Auth id, and the impersonation tenant confinement has to know
 * whether the admin BEHIND a borrowed session is an unbound superuser before
 * it decides how far that session may reach — see
 * `src/lib/impersonation-reach.server.ts`.
 *
 * Same predicate as its sibling, plus `u.status = 'active'`: the confinement's
 * invariant is "no further than the BORROWER could reach AS THEMSELVES", and a
 * blocked, suspended or deactivated admin reaches nothing at all
 * (`decideSecureAccess`), whatever their role rows still say. Without that
 * filter a suspended superadmin would keep an unconfined borrowed session
 * until it expired. The active-ORGANIZATION join is its sibling's (F-09): an
 * admin whose only superuser grant sits in a suspended tenant is not a
 * superadmin as themselves, so a session they borrow is confined too.
 */
export async function betterAuthUserIsGlobalSuperuser(betterAuthUserId: string): Promise<boolean> {
  const row = await db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_users as u", "u.id", "ur.app_user_id")
    .innerJoin("app_organization_memberships as m", (join) =>
      join
        .onRef("m.app_user_id", "=", "ur.app_user_id")
        .onRef("m.organization_id", "=", "ur.organization_id")
        .on("m.status", "=", "active"),
    )
    .innerJoin("app_organizations as o", (join) =>
      join.onRef("o.id", "=", "m.organization_id").on("o.status", "=", ACTIVE_ORGANIZATION_STATUS),
    )
    .innerJoin("app_role_permissions as rp", "rp.role_id", "ur.role_id")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.id")
    .where("u.better_auth_user_id", "=", betterAuthUserId)
    .where("u.status", "=", "active")
    .where("p.key", "=", SUPERADMIN_PERMISSION)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * REVOKE-2 — the LAST-SUPERADMIN invariant.
 *
 * {@link userIsGlobalSuperuser} makes global superuser authority a function of
 * three ordinary, individually-revocable rows: an `app_user_roles` assignment,
 * an `app_role_permissions` link carrying {@link SUPERADMIN_PERMISSION}, and an
 * ACTIVE `app_organization_memberships` row pairing the two — plus, since
 * F-09, the status of the organization that pairing sits in. The seeded
 * `superuser` role is ORG-SCOPED to the default organization, so every one of
 * those rows is reachable by a delegated admin OF THAT ORG — someone holding
 * `admin.roles.assign`, `admin.roles.update`, `admin.users.update` or
 * `admin.orgs.update` there. Revoking the assignment, stripping the marker off
 * the role, or blocking/deleting the membership each destroy the authority
 * PLATFORM-WIDE, and no org admin can confer it back (AUTHZ-3 forbids
 * conferring a permission you do not hold). The platform could therefore be
 * left with NO superadmin and no in-app way to recover.
 *
 * The invariant this file now enforces: **at least one `app_user` must retain
 * an ACTIVE membership plus an assignment of a role carrying the `superuser`
 * permission.** An operation that would empty that set is refused (409
 * `last_superadmin`); an operation that leaves even one route intact is not.
 *
 * Deliberately NOT a "you may not touch a superadmin" rule — a superadmin must
 * still be able to demote a co-superadmin, and an org admin must still manage
 * ordinary members exactly as before. The predicate fires ONLY on the final
 * one, and only when there is something to protect: with zero grants today
 * (a platform that never seeded one, or one whose superuser is conferred
 * through a GROUP — see the note on {@link SuperuserGrant}) it returns false
 * and every revocation proceeds, rather than dead-locking every role edit.
 *
 * ENFORCED ON (keep this list and docs/admin-manager.md §8.1 in step —
 * an invariant that lives in route bodies is an invariant the next route
 * forgets, which is why the last two sit in shared cores, not in routes):
 *
 *   1. `DELETE /users/[id]/app-roles`        — assignment revoke
 *   2. `DELETE /roles/[id]/permissions`      — `superuser` stripped off a role
 *   3. `PATCH|DELETE /users/[id]/memberships`
 *   4. `PATCH|DELETE /organizations/[id]/members`
 *   5. `performAdminStatusChange` (review #444) — the shared status core behind
 *      `POST /users/[id]/status`, `POST /api/v1/users/[id]/status` and the
 *      `block`/`suspend` bulk actions. These are rank-guarded, but
 *      `targetOutranksActor` exempts a SUPERADMIN actor outright, so without
 *      this the last superadmin could block themselves in one request.
 *   6. The soft-delete cascade (review #444) — `DELETE /users/[id]` and the
 *      `soft_delete` bulk action, both of which blanket-block every membership
 *      the target holds.
 *   7. `PATCH /organizations/[id]` moving the org away from `active` (F-09) —
 *      since a grant counts only in an active org, suspending, archiving or
 *      un-activating the tenant that holds the last grants (by default the
 *      seeded default org) would otherwise lock the platform out in one save.
 *
 * NOT enforced on, stated so the wording above is not read as wider than it
 * is: `ban` / `unban` (see the note on `performBan` — they change no row this
 * invariant counts), and any authority conferred through a GROUP (see
 * {@link SuperuserGrant}).
 */

/**
 * One surviving route by which a principal is a global superuser: the
 * (user, org, role) triple {@link userIsGlobalSuperuser} tests for.
 *
 * Group-conferred roles (`app_group_roles`, ADR-0002) are deliberately NOT
 * counted, because {@link userIsGlobalSuperuser} does not count them either:
 * this predicate protects exactly the authority that predicate reports, and
 * the two must stay identical — counting a route the platform's own superuser
 * determination ignores would let the invariant "pass" while the real
 * superadmin set went empty, and vice versa.
 *
 * KNOWN LIMIT, stated so nobody reads more protection into REVOKE-2 than it
 * gives (review #444): `getUserAccessContext` DOES union group-conferred roles
 * into the permission set and then expands a bare `superuser` marker to the
 * full `SUPERUSER_PERMISSIONS` set, so within the group's org a
 * group-conferred superuser really does act as a platform superadmin.
 * {@link userIsGlobalSuperuser} nevertheless reads only direct
 * `app_user_roles`, so such a principal is NOT a "global superuser" anywhere
 * this module decides rank, machine-credential reach (MACHINE-2) or this
 * invariant. Conferring `superuser` THROUGH A GROUP is therefore unsupported:
 * it is not counted here, and a platform whose only superadmin is
 * group-conferred has zero grants, which the escape hatch in
 * {@link stripsLastGlobalSuperuser} turns into "nothing to protect". Confer
 * `superuser` by DIRECT role assignment. What IS protected on the group paths
 * is the conferral symmetry (REVOKE-1): the three group revocation routes run
 * the AUTHZ-3 subset test against the removed set, so a delegated admin who
 * does not hold `superuser` can neither build nor dismantle such a group.
 * Closing the gap properly means teaching BOTH predicates about
 * `app_group_roles` in one change; see docs/admin-manager.md §8.6.
 */
export interface SuperuserGrant {
  appUserId: string;
  organizationId: string;
  roleId: string;
}

/**
 * The rows a pending revocation is about to destroy, expressed in terms of the
 * three ways a {@link SuperuserGrant} can die. Every field is optional; a call
 * site fills in only the shape its own mutation has.
 */
export interface SuperuserGrantRemoval {
  /** `app_user_roles` rows being deleted (the role-assignment revoke path). */
  assignments?: ReadonlyArray<SuperuserGrant>;
  /**
   * Roles that will no longer carry `superuser` (the role-permission strip
   * path). Every grant conferred through one of these roles dies.
   */
  roleIds?: ReadonlyArray<string>;
  /**
   * Memberships that will stop being ACTIVE — a status change away from
   * `active`, or an outright delete. Every grant held in that (user, org) dies,
   * because the active-membership join in {@link userIsGlobalSuperuser} is what
   * makes the assignment count.
   *
   * Note the model this implies: for this shape the grant is SUSPENDED, not
   * destroyed. `app_user_roles` references `app_users` and `app_organizations`
   * but NOT `app_organization_memberships` (migration 0001), and there is no
   * cascade, so deleting a membership leaves the role assignment behind
   * invisibly — re-adding that user to the org silently restores whatever the
   * assignment confers, including `superuser`. Pre-existing and not something
   * this predicate can fix (the cascade would need a schema change, which is an
   * operator gate here), but REVOKE-2 is defined on exactly that join, so it is
   * worth being explicit that "the grant is gone" means "the grant no longer
   * counts", not "the row is gone". See docs/admin-manager.md §8.3.
   */
  memberships?: ReadonlyArray<{ appUserId: string; organizationId: string }>;
  /**
   * Organizations that will stop being ACTIVE (F-09) — `PATCH
   * /organizations/[id]` to `pending`, `suspended` or `archived`. Every grant
   * held in that org dies, whoever holds it, because
   * {@link userIsGlobalSuperuser} joins on the org's status. Like the
   * membership shape, the grant is suspended rather than destroyed:
   * reactivating the org brings it back.
   */
  organizationIds?: ReadonlyArray<string>;
}

/** Pure: would `removal` destroy this particular grant? */
function grantIsRemoved(grant: SuperuserGrant, removal: SuperuserGrantRemoval): boolean {
  if (removal.roleIds?.includes(grant.roleId)) return true;
  if (removal.organizationIds?.includes(grant.organizationId)) return true;
  if (
    removal.assignments?.some(
      (a) =>
        a.appUserId === grant.appUserId &&
        a.organizationId === grant.organizationId &&
        a.roleId === grant.roleId,
    )
  ) {
    return true;
  }
  return (
    removal.memberships?.some(
      (m) => m.appUserId === grant.appUserId && m.organizationId === grant.organizationId,
    ) ?? false
  );
}

/**
 * Pure (REVOKE-2): true when `removal` destroys EVERY grant in `grants` — i.e.
 * the platform would be left with no global superuser at all.
 *
 * `grants.length === 0` returns false on purpose: there is nothing to protect,
 * and refusing there would block legitimate administration forever on any
 * platform that has no direct-assignment superadmin (see {@link SuperuserGrant}).
 *
 * Exported separately from the DB read so the rule itself is unit-testable
 * without a database — the same split as `unheldPermissionKeys` (AUTHZ-3).
 */
export function stripsLastGlobalSuperuser(
  grants: ReadonlyArray<SuperuserGrant>,
  removal: SuperuserGrantRemoval,
): boolean {
  if (grants.length === 0) return false;
  return grants.every((grant) => grantIsRemoved(grant, removal));
}

/**
 * Every (user, org, role) triple that currently confers global superuser
 * authority — the set {@link stripsLastGlobalSuperuser} is measured against.
 *
 * The `FOR UPDATE OF` list is load-bearing, not decoration (REVOKE-2), and it
 * must name EVERY MUTABLE RELATION THE JOIN DEPENDS ON — not just the
 * assignment table. Without a lock the check and the write race: two
 * concurrent revocations, each aimed at a DIFFERENT superadmin, would each
 * read two grants, each conclude "one survives", and together empty the set.
 * READ COMMITTED does not prevent that — a snapshot is not a lock.
 *
 * Why the list and not `OF app_user_roles` alone (review #444): under READ
 * COMMITTED a blocked `SELECT … FOR UPDATE` re-evaluates its predicate against
 * the new row version (EvalPlanQual) only for rows of a LOCKED relation that
 * the committing transaction actually updated or deleted; it does NOT see that
 * transaction's effects on any other table. Only ONE of the guarded paths
 * writes `app_user_roles` (the role-assignment revoke). The membership paths
 * write `app_organization_memberships`, the role-permission strip writes
 * `app_role_permissions`, and the account-lifecycle cascades (soft-delete,
 * status change) write `app_organization_memberships` too. With the lock on
 * the assignment rows alone, the second caller would block on the first,
 * acquire the lock on an UNMODIFIED assignment tuple, skip the recheck, and
 * still evaluate the membership/permission joins against its own pre-commit
 * statement snapshot — in which the other superadmin's membership is still
 * `active`. Locking all three relations means a concurrent membership update /
 * delete or permission detach hits EPQ on a locked relation, the recheck drops
 * the row, and the second caller is correctly refused. `app_permissions` is a
 * static catalog and is deliberately left out.
 *
 * F-09 made the ORGANIZATION'S status part of the join (it must match
 * {@link userIsGlobalSuperuser} exactly), and `PATCH /organizations/[id]` is a
 * guarded path that writes `app_organizations`. By the same argument that
 * relation is locked too: two superadmins suspending two different tenants,
 * each holding one of the last two grants, would otherwise each see the other
 * org as still active.
 *
 * Pass the enclosing transaction as `executor`; calling this on the shared
 * pool takes and releases the lock immediately and protects nothing.
 *
 * The result set is bounded by the number of superuser assignments on the
 * platform (a handful), so reading the rows and filtering in TypeScript is
 * cheaper and far clearer than encoding each removal shape as SQL.
 */
export async function activeGlobalSuperuserGrants(
  executor: Kysely<AppDatabase> = db,
): Promise<SuperuserGrant[]> {
  const rows = await executor
    .selectFrom("app_user_roles")
    .innerJoin("app_organization_memberships", (join) =>
      join
        .onRef("app_organization_memberships.app_user_id", "=", "app_user_roles.app_user_id")
        .onRef(
          "app_organization_memberships.organization_id",
          "=",
          "app_user_roles.organization_id",
        )
        .on("app_organization_memberships.status", "=", "active"),
    )
    .innerJoin("app_organizations", (join) =>
      join
        .onRef("app_organizations.id", "=", "app_organization_memberships.organization_id")
        .on("app_organizations.status", "=", ACTIVE_ORGANIZATION_STATUS),
    )
    .innerJoin("app_role_permissions", "app_role_permissions.role_id", "app_user_roles.role_id")
    .innerJoin("app_permissions", "app_permissions.id", "app_role_permissions.permission_id")
    .where("app_permissions.key", "=", SUPERADMIN_PERMISSION)
    .select([
      "app_user_roles.app_user_id as app_user_id",
      "app_user_roles.organization_id as organization_id",
      "app_user_roles.role_id as role_id",
    ])
    .forUpdate([
      "app_user_roles",
      "app_organization_memberships",
      "app_organizations",
      "app_role_permissions",
    ])
    .execute();
  return rows.map((row) => ({
    appUserId: row.app_user_id,
    organizationId: row.organization_id,
    roleId: row.role_id,
  }));
}

/**
 * REVOKE-2 route guard: would this removal leave the platform with no global
 * superuser? Call it INSIDE the same transaction as the write it guards (see
 * {@link activeGlobalSuperuserGrants} for why the lock matters), and refuse
 * with {@link LAST_SUPERADMIN_ERROR} / 409 when it returns true.
 */
export async function wouldStripLastGlobalSuperuser(
  removal: SuperuserGrantRemoval,
  executor: Kysely<AppDatabase> = db,
): Promise<boolean> {
  return stripsLastGlobalSuperuser(await activeGlobalSuperuserGrants(executor), removal);
}

/**
 * REVOKE-2 for the ACCOUNT-LIFECYCLE cascades (review #444).
 *
 * The four revocation routes name the rows they are about to remove, so they
 * build a {@link SuperuserGrantRemoval} literal. The lifecycle cascades do not:
 * soft-delete (`DELETE /users/[id]` and its bulk twin) blanket-blocks EVERY
 * membership of the target, and `performAdminStatusChange` moves every
 * membership in the actor's scope away from `active`. Both are still exactly
 * the `memberships` removal shape, so they take the SAME predicate instead of a
 * second mechanism that could drift from it — they just have to resolve the
 * affected (user, org) pairs first.
 *
 * Reads those pairs through the CALLER'S transaction so the grant read below
 * takes its row locks there too; calling this on the shared pool protects
 * nothing (see {@link activeGlobalSuperuserGrants}).
 *
 * `organizationId` confines the read to one tenant for a caller whose write is
 * org-confined (AUTHZ-1); omit it when the cascade is account-global, so the
 * predicate measures every membership the write will touch and no more.
 */
export async function membershipCascadeStripsLastGlobalSuperuser(
  appUserId: string,
  executor: Kysely<AppDatabase>,
  organizationId?: string,
): Promise<boolean> {
  let query = executor
    .selectFrom("app_organization_memberships")
    .select("organization_id")
    .where("app_user_id", "=", appUserId);
  if (organizationId !== undefined) {
    query = query.where("organization_id", "=", organizationId);
  }
  const rows = await query.execute();
  return wouldStripLastGlobalSuperuser(
    {
      memberships: rows.map((row) => ({ appUserId, organizationId: row.organization_id })),
    },
    executor,
  );
}

/**
 * Wire + audit vocabulary for a REVOKE-2 refusal, shared by all four
 * revocation paths so the audit explorer can list every attempt to remove the
 * last superadmin with a single filter — exactly as
 * `TARGET_OUTRANKS_ACTOR_EVENT` does for the rank guard.
 *
 * 409 (not 403): the caller is not forbidden from revoking superuser roles in
 * general — the platform's CURRENT state is what conflicts with this one.
 */
export const LAST_SUPERADMIN_ERROR = "last_superadmin";
export const LAST_SUPERADMIN_STATUS = 409;
export const LAST_SUPERADMIN_EVENT = "admin.superuser.revocation_denied";
export const LAST_SUPERADMIN_REASON = "last_global_superuser";

/**
 * Control-flow signal for a REVOKE-2 refusal raised INSIDE a transaction that
 * has already done work the caller must undo — the soft-delete saga, which
 * applies the Better Auth ban before its DB cascade (#B6) and therefore has to
 * roll the transaction back AND compensate the ban.
 *
 * Shared rather than re-declared per call site so `instanceof` still matches
 * when the throw and the catch live in different modules, and so a future
 * cascade cannot invent a second, subtly different signal.
 */
export class LastSuperadminCascadeError extends Error {
  constructor() {
    super(LAST_SUPERADMIN_REASON);
    this.name = "LastSuperadminCascadeError";
  }
}
