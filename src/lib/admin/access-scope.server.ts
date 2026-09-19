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
 * Returns true when the OWNER outranks the ACTOR: the owner resolves as a
 * superadmin and the actor does not. A superadmin actor is exempt — they
 * already hold every power, so they confer nothing they lack.
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
 * the marker.
 *
 * MACHINE-2: "all orgs" describes the human, not every credential they own. A
 * request presenting an org-bound credential is capped to that org by
 * {@link hasCrossOrgReach}; this predicate is unchanged and still reports the
 * principal's true rank (the on-behalf mint bounds rely on exactly that).
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
 * until it expired.
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
