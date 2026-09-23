import "server-only";
import { cookies } from "next/headers";
import { db } from "@/db/database";
import { ACTIVE_ORGANIZATION_STATUS } from "@/lib/validation/organizations";

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
 *
 * IMP-1 — "the caller's own memberships" is the memberships of whoever the
 * SESSION NAMES, which during an impersonation is the TARGET, not the admin
 * holding the browser. The cookie is unsigned and freely editable by its own
 * owner, so that sentence alone does NOT confine an impersonated session to
 * the tenant impersonation started in. The confinement is
 * `listImpersonationReachableOrgIds` (src/lib/impersonation-reach.server.ts),
 * which is built on {@link listActiveOrganizationIdsForBetterAuthUser} and is
 * applied by `getUserAccessContext` on the cookie path.
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

/**
 * Organizations the user is an ACTIVE member of (for the switcher), by name.
 * Only ACTIVE organizations are listed (F-09): `getUserAccessContext` can
 * never resolve a suspended one, so offering it would be a switch that lands
 * back where it started.
 */
export async function listUserActiveOrganizations(appUserId: string): Promise<UserOrganization[]> {
  return db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select(["o.id as id", "o.slug as slug", "o.name as name"])
    .where("m.app_user_id", "=", appUserId)
    .where("m.status", "=", "active")
    .where("o.status", "=", ACTIVE_ORGANIZATION_STATUS)
    .orderBy("o.name", "asc")
    .execute();
}

/**
 * Organization ids the principal holds an ACTIVE membership in, keyed by
 * BETTER AUTH user id (not the `app_users` primary key).
 *
 * IMP-1 (impersonation tenant confinement). `getUserAccessContext` uses this —
 * through {@link listImpersonationReachableOrgIds}, which owns the superuser
 * exemption — to intersect an IMPERSONATED session's memberships with the
 * IMPERSONATOR'S, so a borrowed session can never resolve an organization the
 * admin who borrowed it does not already belong to. It is keyed on the Better
 * Auth id because that is the only identifier Better Auth's `impersonatedBy`
 * marker carries — resolving it to an `app_users` row first would cost a
 * second round trip for nothing.
 *
 * BOTH status filters are load-bearing, and they are different statuses:
 *   - `m.status = 'active'` (the MEMBERSHIP), mirroring
 *     {@link userHasActiveMembership}: a suspended or pending membership does
 *     not let the admin act in that tenant themselves, so it must not widen
 *     what a session they borrow can reach either.
 *   - `u.status = 'active'` (the ACCOUNT, IMP-2). Suspending or blocking a
 *     user writes `app_users.status` (`POST /api/administrator/users/[id]/
 *     status`) and leaves their membership rows untouched, so without this the
 *     confinement's own fail-closed branch was a fiction: a just-suspended
 *     admin kept the full intersection and the session they had borrowed kept
 *     its full reach until it expired. `decideSecureAccess` is the authority
 *     on which statuses block, and it allows exactly `active`.
 *
 * A third filter joined in by F-09: `o.status = 'active'` (the
 * ORGANIZATION). An admin cannot act as themselves in a suspended tenant, so a
 * session they borrow cannot reach into it either.
 *
 * An unprovisioned, suspended or membership-less impersonator yields `[]`,
 * which the caller MUST treat as "resolve nothing" (fail closed), never as
 * "unconfined".
 */
export async function listActiveOrganizationIdsForBetterAuthUser(
  betterAuthUserId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_users as u", "u.id", "m.app_user_id")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select("m.organization_id as organization_id")
    .where("u.better_auth_user_id", "=", betterAuthUserId)
    .where("u.status", "=", "active")
    .where("m.status", "=", "active")
    .where("o.status", "=", ACTIVE_ORGANIZATION_STATUS)
    .execute();
  return [...new Set(rows.map((r) => r.organization_id))];
}

/**
 * Whether the user holds an ACTIVE membership in the given org. Gate for
 * switching: you may only make an org active if you can actually enter it —
 * which since F-09 also requires the ORGANIZATION to be active. Without that,
 * `POST /api/preferences/active-org` would accept (and audit) a switch INTO a
 * suspended tenant that `getUserAccessContext` then silently ignores.
 */
export async function userHasActiveMembership(
  appUserId: string,
  organizationId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select("m.id")
    .where("m.app_user_id", "=", appUserId)
    .where("m.organization_id", "=", organizationId)
    .where("m.status", "=", "active")
    .where("o.status", "=", ACTIVE_ORGANIZATION_STATUS)
    .executeTakeFirst();
  return row !== undefined;
}
