import "server-only";
import { cache } from "react";
import { db } from "@/db/database";
import { readActiveOrgId } from "@/lib/active-org.server";
import { userIsGlobalSuperuser } from "@/lib/admin/access-scope.server";
import { listImpersonationReachableOrgIds } from "@/lib/impersonation-reach.server";
import {
  SHELL_BASELINE_PERMISSION,
  SUPERADMIN_PERMISSION,
  SUPERUSER_PERMISSIONS,
} from "@/lib/admin/permissions";
import { APP_USER_STATUS_VALUES, MEMBERSHIP_STATUS_VALUES } from "@/lib/status-values";
import { ACTIVE_ORGANIZATION_STATUS } from "@/lib/validation/organizations";

/** Possible application-level user statuses (mirrored by a DB CHECK, review #217). */
export type AppUserStatus = (typeof APP_USER_STATUS_VALUES)[number];

/** Possible membership statuses inside an organization (mirrored by a DB CHECK, review #217). */
export type MembershipStatus = (typeof MEMBERSHIP_STATUS_VALUES)[number];

export interface UserAccessContext {
  appUserId: string | null;
  primaryEmail: string | null;
  status: AppUserStatus;
  organizationId: string | null;
  membershipStatus: MembershipStatus | null;
  preferredLocale: string;
  permissions: string[];
  /**
   * True when this context was resolved against a BEARER CREDENTIAL'S BOUND
   * ORG (MACHINE-2) rather than the browser's `active_org` cookie — i.e. the
   * caller is a machine credential pinned to one tenant.
   *
   * `getUserAccessContext` ALWAYS sets it explicitly (`true` whenever a
   * `boundOrg` argument was supplied, `false` on the cookie/session path), so
   * no real code path is ever ambiguous. It is declared OPTIONAL only so the
   * many hand-built `UserAccessContext` literals in the test suite — and any
   * other caller that constructs a context by hand — keep compiling; an
   * absent marker means "not org-bound", the pre-existing behaviour.
   *
   * Consumers must not read this directly to make an authorization decision:
   * the cap lives in `@/lib/admin/access-scope.server`
   * (`resolveOrgScope` / `canAccessOrg` / `canAccessUser` / `hasCrossOrgReach`)
   * so the rule has exactly one home.
   */
  orgBound?: boolean;
}

/** Status values that block access to all secure routes. */
const BLOCKED_USER_STATUSES = new Set<AppUserStatus>(["blocked", "suspended", "deactivated"]);

/** Every recognized app/membership status, for boundary validation. */
const USER_STATUSES = new Set<AppUserStatus>(APP_USER_STATUS_VALUES);
const MEMBERSHIP_STATUSES = new Set<MembershipStatus>(MEMBERSHIP_STATUS_VALUES);

/**
 * Coerce a raw DB status to {@link AppUserStatus}, failing CLOSED on an
 * unrecognized value (P3-11). The status feeds the security decision, so a
 * schema drift / bad row must never be `as`-cast into a value that could grant
 * access — an unknown status resolves to a blocking one.
 */
function toUserStatus(value: unknown): AppUserStatus {
  return typeof value === "string" && USER_STATUSES.has(value as AppUserStatus)
    ? (value as AppUserStatus)
    : "deactivated";
}

/** Coerce a raw DB membership status, failing CLOSED (`suspended`) on an
 *  unrecognized value so it can never resolve to `active`. */
function toMembershipStatus(value: unknown): MembershipStatus {
  return typeof value === "string" && MEMBERSHIP_STATUSES.has(value as MembershipStatus)
    ? (value as MembershipStatus)
    : "suspended";
}

/**
 * Pure helper: maps user + membership statuses to a final secure-access
 * decision. Kept pure so it can be unit-tested without a database.
 */
export function decideSecureAccess(
  status: AppUserStatus,
  membership: MembershipStatus | null,
): "allow" | "pending_approval" | "blocked" {
  if (BLOCKED_USER_STATUSES.has(status)) return "blocked";
  if (status === "pending_approval") return "pending_approval";
  if (membership === null) return "pending_approval";
  if (membership === "pending_approval") return "pending_approval";
  if (membership === "blocked" || membership === "suspended") return "blocked";
  if (status === "active" && membership === "active") return "allow";
  return "pending_approval";
}

/**
 * Selects which organization a bearer credential (API key / JWT) acts in.
 *
 * `organizationId` is the org the credential was MINTED for
 * (`app_api_keys.organization_id` / the JWT `org` claim). Passing this to
 * {@link getUserAccessContext} makes the credential resolve against that org
 * and bypass the `active_org` cookie entirely, so a credential can never be
 * steered into a different tenant by a (spoofable) cookie — see MACHINE-1.
 * A `null` bound org (an org-less credential) falls back to the principal's
 * earliest membership that counts (`created_at`, then `id`): deterministic,
 * and still cookie-independent.
 */
export interface BoundOrg {
  organizationId: string | null;
}

/**
 * Marks a COOKIE SESSION as an IMPERSONATION and names the admin behind it
 * (Better Auth's `session.impersonatedBy`) — the sibling of {@link BoundOrg}
 * for the other credential kind (IMP-1).
 *
 * Passing this to {@link getUserAccessContext} confines the resolved
 * organization to one the IMPERSONATOR could already reach as themselves, so
 * a borrowed session can never leave the borrower's own tenancy. "Could reach"
 * is membership for every principal except an unbound global superuser, whose
 * reach is conferred by permission — `src/lib/impersonation-reach.server.ts`
 * owns that distinction (IMP-2).
 *
 * WHY THIS EXISTS. The impersonate route's escalation guard evaluates the
 * target's permissions in ONE organization, and the only thing that used to
 * make that sound was the pair of refusals on
 * `/api/preferences/active-org(/apply)`. But `active_org` is a plain UNSIGNED
 * cookie that `getUserAccessContext` reads for whichever user the session
 * names — during an impersonation, the TARGET. `httpOnly` stops other sites
 * reading it; it does not stop the browser's own owner rewriting it in
 * devtools or replaying the request with curl. So an org-A admin could
 * impersonate a user who is a plain member in A but an ADMIN in org B (the
 * escalation guard passes, because the target holds nothing in A), then set
 * `active_org` to B and wield the target's admin authority in a tenant the
 * guard never evaluated. Enumeration was the only obstacle, and the
 * impersonated shell renders the target's org ids itself.
 *
 * WHY THE INTERSECTION RATHER THAN REFUSING ADMIN POWERS OUTRIGHT. Assuming
 * an org admin's session inside the admin's OWN tenant is the point of
 * impersonation ("reproduce what this user sees"); blanket-refusing `admin.*`
 * while impersonating would break that legitimate support flow and would be a
 * permission rule bolted onto a tenancy problem. The intersection fixes the
 * tenancy problem where it actually is: whatever the borrowed session can
 * reach, the borrower could already reach as themselves.
 *
 * NOT A SCHEMA CHANGE. Better Auth already persists `impersonatedBy` on the
 * session row; this only threads the value that is already there.
 */
export interface ImpersonatedBy {
  /** The ORIGINAL admin's Better Auth user id. */
  betterAuthUserId: string;
}

/**
 * Loads application-level access context for a Better Auth user id.
 *
 * Returns a synthetic `pending_approval` context when the user has not yet
 * been provisioned into the application tables — this happens between
 * sign-up and the first call to the user-provisioning service. Pages that
 * call this function MUST treat any non-`active` status as a hard block.
 *
 * Wrapped in React `cache()` so the secure layout, nested layouts, and
 * page-level guards resolving the same user within one request share a
 * single set of DB round-trips. The memoization is per-request (and a
 * no-op outside React rendering), so it never serves stale permissions
 * across requests.
 *
 * IMP-1: a COOKIE-SESSION caller must not call this directly — it cannot see
 * the session and therefore cannot know whether the session is an
 * impersonation. Use `getSessionAccessContext` (src/lib/session-access.server.ts),
 * which derives {@link ImpersonatedBy} from the session itself. That rule is
 * enforced by the source scan in
 * tests/unit/session-access-context-invariant.test.ts, which allow-lists the
 * few modules that legitimately resolve a NON-session principal (a
 * credential's bound org, a target user, a credential owner).
 */
export const getUserAccessContext = cache(async function getUserAccessContext(
  betterAuthUserId: string,
  boundOrg?: BoundOrg,
  impersonatedBy?: ImpersonatedBy,
): Promise<UserAccessContext> {
  const user = await db
    .selectFrom("app_users")
    .select(["id", "primary_email", "status", "preferred_locale"])
    .where("better_auth_user_id", "=", betterAuthUserId)
    .executeTakeFirst();

  if (!user) {
    return {
      appUserId: null,
      primaryEmail: null,
      status: "pending_approval",
      organizationId: null,
      membershipStatus: null,
      preferredLocale: "en",
      permissions: [],
      // Set even on the unprovisioned short-circuit: the marker describes HOW
      // the caller presented itself, not what was found, so every context this
      // function returns carries it explicitly (MACHINE-2).
      orgBound: boundOrg !== undefined,
    };
  }

  // F-09 — a membership COUNTS only while its organization is `active`. Every
  // lookup below starts from this one builder, so an org that is `pending`,
  // `suspended` or `archived` resolves exactly as if the membership row did not
  // exist: no org, no permissions, and `decideSecureAccess` refuses the caller
  // (pending_approval, the same answer as for a user with no membership). That
  // single rule is what the secure shell, the admin and v1 guards, the token
  // endpoint, SSO launch and every bound credential inherit. Before it, the
  // status an operator set on the Settings tab was a badge and nothing more:
  // a suspended tenant's members, org admins, API keys and SSO launches all
  // kept working.
  //
  // Filtering in SQL (rather than reading the org's status back and deciding
  // here) keeps every lookup below on ONE predicate, so a stale `active_org`
  // cookie naming a suspended org falls through to the user's best-ranked
  // membership in an org that still counts (F-33, below) — a member of both a
  // suspended and an active tenant keeps working in the active one.
  const countingMemberships = () =>
    db
      .selectFrom("app_organization_memberships as m")
      .innerJoin("app_organizations as o", "o.id", "m.organization_id")
      .select(["m.organization_id as organization_id", "m.status as status"])
      .where("m.app_user_id", "=", user.id)
      .where("o.status", "=", ACTIVE_ORGANIZATION_STATUS);

  let membership;
  if (boundOrg !== undefined) {
    // Bearer-credential path: act in the org the credential is bound to, and
    // NEVER read the active_org cookie (MACHINE-1). A bound org the principal
    // no longer holds an active membership in resolves to that non-active
    // membership, or to none, and `decideSecureAccess` refuses either — the
    // credential fails closed rather than silently acting elsewhere. The same
    // holds while the bound org is not active (F-09): a key or token minted
    // for a suspended tenant stops authenticating, and works again only when
    // the tenant is reactivated. An ORG-LESS credential takes the earliest
    // membership that still counts (`created_at`, with `id` breaking a tie as
    // on the session path below), i.e. a suspended org is skipped exactly as a
    // deleted membership would be.
    //
    // F-33 deliberately does NOT rank this path by MEMBERSHIP status. A person
    // at a browser can see which org they landed in and switch; a machine
    // client cannot. So a non-active earliest membership resolves as it is and
    // stops an org-less credential, as a non-active bound membership stops a
    // bound one, rather than moving it into another tenant whose admins never
    // saw it act. That is all this path promises: the earliest membership is
    // not a binding. Suspending its ORGANIZATION (F-09) or deleting the
    // membership row still moves an org-less credential on to the next
    // membership that counts. Only a bound credential stays in one org.
    membership = boundOrg.organizationId
      ? await countingMemberships()
          .where("m.organization_id", "=", boundOrg.organizationId)
          .executeTakeFirst()
      : await countingMemberships()
          .orderBy("m.created_at", "asc")
          .orderBy("m.id", "asc")
          .executeTakeFirst();
  } else {
    // Cookie/session path. Multi-org: the active org is selected by a cookie,
    // among the user's memberships ranked in ONE statement (F-33):
    //
    //   1. an ACTIVE membership before one of any other status;
    //   2. then the org the `active_org` cookie names, if any;
    //   3. then the earliest (`created_at`, with `id` breaking a tie so that
    //      rows written by one transaction cannot resolve differently between
    //      requests).
    //
    // So the cookie picks among the user's active memberships, and an unset,
    // stale or forged cookie lands them in their earliest active one (the
    // historical single-org behavior). The `app_user_id` filter makes a forged
    // cookie harmless — it can only ever select among the user's own
    // memberships.
    //
    // F-33 — before this ranking the cookie lookup and the earliest-membership
    // fallback each took whatever row matched, whatever its status. Suspending
    // or blocking a user's membership in ONE org — an action an org admin may
    // take in their own tenant only (AUTHZ-1) — then locked them out of EVERY
    // org while their cookie named it: every request resolved the suspended
    // row and `decideSecureAccess` sent them to /blocked, across sign-out and
    // sign-in, for up to the cookie's one-year life. With no cookie, a user
    // left `pending_approval` in the default org (their earliest row) who then
    // accepted an invitation into another org landed on /pending-approval.
    //
    // A non-active membership is ranked LAST, not filtered out. A user with no
    // active membership anywhere must still resolve to one, so the secure shell
    // can tell a pending user (/pending-approval) from a suspended or blocked
    // one (/blocked) — and among those rows the cookie and the earliest still
    // decide, as before. The ranking chooses only among the rows the WHERE
    // admits, the same set the old fallback chose from, so it changes WHICH of
    // the user's memberships resolves and never widens the set that can.
    //
    // The stale cookie is left alone rather than rewritten. A Server Component
    // render cannot set a cookie, and nothing needs it to: while the membership
    // it names is not active it simply ranks below every active one, and if
    // that org reinstates the user, their own last choice applies again.
    //
    // IMP-1 — …and during an IMPERSONATION "the user" is the TARGET, so that
    // filter alone lets the admin holding the browser rewrite the unsigned
    // `active_org` cookie and steer the borrowed session into any tenant the
    // target belongs to, including ones the impersonate route's escalation
    // guard never evaluated. So when the session is an impersonation, the
    // ranked lookup is additionally confined to the organizations the
    // IMPERSONATOR could reach AS THEMSELVES: the borrowed session reaches
    // exactly that much, and nothing more. See {@link ImpersonatedBy}.
    //
    // IMP-2 — "could reach as themselves" is `listImpersonationReachableOrgIds`,
    // NOT a raw membership query: for an unbound global superuser reach is
    // conferred by permission rather than by membership, and measuring them by
    // membership stranded the platform operator's own support flow in a dead
    // session. That module owns the distinction and the argument for why
    // exempting a superadmin cannot reopen the pivot.
    let confinedOrgIds: string[] | null = null;
    if (impersonatedBy) {
      confinedOrgIds = await listImpersonationReachableOrgIds(impersonatedBy.betterAuthUserId);
    }

    if (confinedOrgIds !== null && confinedOrgIds.length === 0) {
      // FAIL CLOSED. An impersonator who could reach no tenant as themselves —
      // their account was suspended or their last membership revoked
      // mid-session — shares no tenant with the target, so the intersection is
      // empty and the borrowed session resolves to NO membership: no org, no
      // permissions, and `decideSecureAccess` blocks every secure surface.
      // Skipping the queries here also keeps an empty `in ()` out of the SQL.
      membership = undefined;
    } else {
      // ONE statement makes the choice (F-33), so the confinement and the
      // F-09 organization-status predicate sit in the only WHERE there is:
      // neither can be applied to the cookie's pick but forgotten on the
      // fallback, which would reopen the pivot for any target whose EARLIEST
      // membership is outside the impersonator's tenancy.
      let candidates = countingMemberships();
      if (confinedOrgIds !== null) {
        candidates = candidates.where("m.organization_id", "in", confinedOrgIds);
      }

      let ranked = candidates.orderBy((eb) => eb("m.status", "=", "active"), "desc");
      const activeOrgId = await readActiveOrgId();
      if (activeOrgId) {
        ranked = ranked.orderBy((eb) => eb("m.organization_id", "=", activeOrgId), "desc");
      }
      membership = await ranked
        .orderBy("m.created_at", "asc")
        .orderBy("m.id", "asc")
        .limit(1)
        .executeTakeFirst();
    }
  }

  // Coerce once (fail-closed) — reused for the baseline grant below and the
  // returned context.
  const appStatus = toUserStatus(user.status);
  const memberStatus = membership ? toMembershipStatus(membership.status) : null;

  let permissions: string[] = [];
  if (membership) {
    const orgId = membership.organization_id;
    // Effective roles within the active org = roles assigned DIRECTLY
    // (app_user_roles) UNION roles conferred by the user's GROUPS
    // (app_group_memberships → app_group_roles), per ADR-0002. Both branches
    // are filtered to the active org, so a group only counts when it belongs
    // to that org — keeping groups inside the ADR-0001 boundary. Resolved to
    // permission keys in one statement via UNION (dedups).
    const directPerms = db
      .selectFrom("app_user_roles as ur")
      .innerJoin("app_role_permissions as rp", "rp.role_id", "ur.role_id")
      .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
      .select("p.key as key")
      .where("ur.app_user_id", "=", user.id)
      .where("ur.organization_id", "=", orgId);
    const groupPerms = db
      .selectFrom("app_group_memberships as gm")
      .innerJoin("app_groups as g", "g.id", "gm.group_id")
      .innerJoin("app_group_roles as gr", "gr.group_id", "g.id")
      .innerJoin("app_role_permissions as rp", "rp.role_id", "gr.role_id")
      .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
      .select("p.key as key")
      .where("gm.app_user_id", "=", user.id)
      .where("g.organization_id", "=", orgId);
    const rows = await directPerms.union(groupPerms).execute();
    permissions = [...new Set(rows.map((r) => r.key))];
  }

  // Baseline: `shell.view` is IMPLIED by an active membership, not conferred by
  // a role (the same invariant the account API guard and `decideSecureAccess`
  // rely on). A self-registered member holds no role, so without this they
  // resolve to an empty set and the server-filtered shell nav — Dashboard AND
  // Account — is filtered to nothing. Granted exactly when secure access is
  // allowed (active user + active membership); it is not an `admin.*`
  // capability, so this never widens administrative authority. Superusers
  // already carry it via SUPERUSER_PERMISSIONS.
  if (
    decideSecureAccess(appStatus, memberStatus) === "allow" &&
    !permissions.includes(SHELL_BASELINE_PERMISSION)
  ) {
    permissions = [...permissions, SHELL_BASELINE_PERMISSION];
  }

  // Global superuser: holding the `superuser` permission via a role in ANY
  // org the user is an active member of makes them a SUPERADMIN everywhere —
  // the active org must never downgrade it. "Org" means an ACTIVE org (F-09):
  // a grant held only in a suspended tenant makes nobody a platform superadmin
  // (`userIsGlobalSuperuser` carries the same predicate as the lookups above).
  //
  // MACHINE-2: "everywhere" is about the PRINCIPAL, not about a credential the
  // principal owns. The expansion below therefore still runs on the bound-org
  // path (an org-bound superuser genuinely holds every capability INSIDE its
  // bound tenant, and downgrading the permission set here would silently break
  // every `permissions.includes("admin.*")` gate). What must NOT follow from it
  // is cross-tenant REACH: `orgBound` is returned alongside the permissions so
  // `resolveOrgScope` / `canAccessOrg` / `canAccessUser` can cap a bound
  // credential to its own org. Do not "fix" this by dropping the expansion —
  // that would turn a scoping bug into an authentication bug.
  //
  // Expand the marker to the FULL
  // superuser permission set so every consumer of `permissions` — the admin
  // gates, the server-filtered nav menu, and the per-feature `canX` toggles
  // on the RSC pages — recognizes them uniformly, EVEN when their role
  // carries only the bare marker (e.g. the dev seed's per-org `superuser`
  // role, which grants `superuser` but not the individual `admin.*` keys).
  //
  // The marker already being present in the active org only lets us skip the
  // extra `userIsGlobalSuperuser` DB lookup — it must NOT skip the expansion,
  // or a bare-marker superuser ends up with `["shell.view", "superuser"]` and
  // every `permissions.includes("admin.*")` check fails.
  const holdsSuperuserMarker = permissions.includes(SUPERADMIN_PERMISSION);
  if (membership && (holdsSuperuserMarker || (await userIsGlobalSuperuser(user.id)))) {
    permissions = [...new Set([...permissions, ...SUPERUSER_PERMISSIONS])];
  }

  return {
    appUserId: user.id,
    primaryEmail: user.primary_email,
    status: appStatus,
    organizationId: membership?.organization_id ?? null,
    membershipStatus: memberStatus,
    preferredLocale: user.preferred_locale,
    permissions,
    // MACHINE-2 — always explicit: a `boundOrg` argument means this context
    // belongs to a bearer credential pinned to one tenant, and the scope
    // helpers cap it there even for a global superuser principal.
    orgBound: boundOrg !== undefined,
  };
});
