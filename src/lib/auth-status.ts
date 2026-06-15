import "server-only";
import { cache } from "react";
import { db } from "@/db/database";
import { readActiveOrgId } from "@/lib/active-org.server";

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
    const rows = await db
      .selectFrom("app_user_roles as ur")
      .innerJoin("app_role_permissions as rp", "rp.role_id", "ur.role_id")
      .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
      .select(["p.key as key"])
      .where("ur.app_user_id", "=", user.id)
      .where("ur.organization_id", "=", membership.organization_id)
      .execute();
    permissions = rows.map((r) => r.key);
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
