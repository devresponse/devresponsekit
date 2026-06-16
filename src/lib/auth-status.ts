import "server-only";
import { cache } from "react";
import { db } from "@/db/database";
import { readActiveOrgId } from "@/lib/active-org.server";
import { userIsGlobalSuperuser } from "@/lib/admin/access-scope.server";
import { SUPERADMIN_PERMISSION, SUPERUSER_PERMISSIONS } from "@/lib/admin/permissions";

/** Possible application-level user statuses. */
export type AppUserStatus = "active" | "pending_approval" | "blocked" | "suspended" | "deactivated";

/** Possible membership statuses inside an organization. */
export type MembershipStatus = "active" | "pending_approval" | "blocked" | "suspended";

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

  // Multi-org: the active org is selected by a cookie. Prefer the membership
  // it names; if the cookie is unset, stale, or names an org the user is not
  // a member of, fall back to their earliest membership (the historical
  // single-org behavior). The `app_user_id` filter makes a forged cookie
  // harmless — it can only ever select among the user's own memberships.
  const activeOrgId = await readActiveOrgId();
  let membership = activeOrgId
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

  // Global superuser: holding the `superuser` permission via a role in ANY
  // org the user is an active member of makes them a SUPERADMIN everywhere —
  // the active org must never downgrade it. Grant the full superuser set so
  // every gate (admin routes, the server-filtered nav menu, …) recognizes
  // them uniformly regardless of which org is active. Skip the lookup when the
  // active org already grants the marker (the common case for a superuser).
  if (
    membership &&
    !permissions.includes(SUPERADMIN_PERMISSION) &&
    (await userIsGlobalSuperuser(user.id))
  ) {
    permissions = [...new Set([...permissions, ...SUPERUSER_PERMISSIONS])];
  }

  return {
    appUserId: user.id,
    primaryEmail: user.primary_email,
    status: user.status as AppUserStatus,
    organizationId: membership?.organization_id ?? null,
    membershipStatus: (membership?.status as MembershipStatus | undefined) ?? null,
    preferredLocale: user.preferred_locale,
    permissions,
  };
});
