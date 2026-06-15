import "server-only";
import { cookies } from "next/headers";
import { db } from "@/db/database";

/**
 * Active-organization selection (cookie-based multi-org support).
 *
 * A single identity (`app_users`) can hold memberships in many
 * organizations. `getUserAccessContext` resolves ONE active org per
 * request; this module is the source of truth for which one. The active
 * org is carried in a cookie so that EVERY server consumer — the secure
 * layout, the admin API guard, the navigation menu — resolves the same org
 * with no per-call plumbing ("consistent by construction").
 *
 * Security: the cookie only SELECTS among the caller's own memberships. The
 * membership filter in `getUserAccessContext` (and `userHasActiveMembership`
 * here) is the authority — a forged or stale cookie naming an org the user
 * is not an active member of simply falls back to their primary membership
 * and can never grant access. So the cookie does not need to be signed.
 */
export const ACTIVE_ORG_COOKIE = "active_org";

/** A switchable organization for the current user. */
export interface UserOrganization {
  id: string;
  slug: string;
  name: string;
}

/**
 * The active organization id from the request cookie, or `null` when unset.
 * Resilient to being called outside a request scope (e.g. in unit tests):
 * `cookies()` throws there, which we treat as "no active org".
 */
export async function readActiveOrgId(): Promise<string | null> {
  try {
    const store = await cookies();
    const value = store.get(ACTIVE_ORG_COOKIE)?.value?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/** Organizations the user is an ACTIVE member of (for the switcher), by name. */
export async function listUserActiveOrganizations(appUserId: string): Promise<UserOrganization[]> {
  return db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select(["o.id as id", "o.slug as slug", "o.name as name"])
    .where("m.app_user_id", "=", appUserId)
    .where("m.status", "=", "active")
    .orderBy("o.name", "asc")
    .execute();
}

/**
 * Whether the user holds an ACTIVE membership in the given org. Gate for
 * switching: you may only make an org active if you can actually enter it.
 */
export async function userHasActiveMembership(
  appUserId: string,
  organizationId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("app_organization_memberships")
    .select("id")
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", organizationId)
    .where("status", "=", "active")
    .executeTakeFirst();
  return row !== undefined;
}
