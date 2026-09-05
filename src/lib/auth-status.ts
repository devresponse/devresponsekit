import "server-only";
import { cache } from "react";
import { db } from "@/db/database";
import { readActiveOrgId } from "@/lib/active-org.server";
import { userIsGlobalSuperuser } from "@/lib/admin/access-scope.server";
import {
  SHELL_BASELINE_PERMISSION,
  SUPERADMIN_PERMISSION,
  SUPERUSER_PERMISSIONS,
} from "@/lib/admin/permissions";
import { APP_USER_STATUS_VALUES, MEMBERSHIP_STATUS_VALUES } from "@/lib/status-values";

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
 * earliest membership: deterministic, and still cookie-independent.
 */
export interface BoundOrg {
  organizationId: string | null;
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
 */
export const getUserAccessContext = cache(async function getUserAccessContext(
  betterAuthUserId: string,
  boundOrg?: BoundOrg,
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
    };
  }

  let membership;
  if (boundOrg !== undefined) {
    // Bearer-credential path: act in the org the credential is bound to, and
    // NEVER read the active_org cookie (MACHINE-1). A bound org the principal
    // no longer holds an active membership in resolves to no membership, so
    // the access context carries no permissions and the guard denies — the
    // credential fails closed rather than silently acting elsewhere.
    membership = boundOrg.organizationId
      ? await db
          .selectFrom("app_organization_memberships")
          .select(["organization_id", "status"])
          .where("app_user_id", "=", user.id)
          .where("organization_id", "=", boundOrg.organizationId)
          .executeTakeFirst()
      : await db
          .selectFrom("app_organization_memberships")
          .select(["organization_id", "status"])
          .where("app_user_id", "=", user.id)
          .orderBy("created_at", "asc")
          .executeTakeFirst();
  } else {
    // Cookie/session path. Multi-org: the active org is selected by a cookie.
    // Prefer the membership it names; if the cookie is unset, stale, or names
    // an org the user is not a member of, fall back to their earliest
    // membership (the historical single-org behavior). The `app_user_id`
    // filter makes a forged cookie harmless — it can only ever select among
    // the user's own memberships.
    const activeOrgId = await readActiveOrgId();
    membership = activeOrgId
      ? await db
          .selectFrom("app_organization_memberships")
          .select(["organization_id", "status"])
          .where("app_user_id", "=", user.id)
          .where("organization_id", "=", activeOrgId)
          .executeTakeFirst()
      : undefined;
    if (!membership) {
      membership = await db
        .selectFrom("app_organization_memberships")
        .select(["organization_id", "status"])
        .where("app_user_id", "=", user.id)
        .orderBy("created_at", "asc")
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
  // the active org must never downgrade it. Expand the marker to the FULL
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
  };
});
