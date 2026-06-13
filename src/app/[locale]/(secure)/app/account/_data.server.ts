import "server-only";
import { db } from "@/db/database";

/**
 * Account data access (self-service).
 *
 * Every function takes the CALLER'S OWN identifiers — resolved from the
 * session by the page, never from client input — and scopes every query
 * to that user. There is no code path here that can read another user's
 * data. Display logic lives in the pages/components; queries live here
 * (the same separation the Administrator overview uses).
 */

export interface AccountProfile {
  appUserId: string;
  displayName: string | null;
  /** Better Auth `user.name` (vendor table; read here, written via the API). */
  name: string | null;
  primaryEmail: string;
  createdAt: Date;
}

export interface AccountPreferences {
  preferredLocale: string;
  timeZone: string | null;
  dateFormat: string | null;
  numberFormatLocale: string | null;
}

export interface AccountMembership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  status: string;
}

export interface AccountOverview {
  displayName: string | null;
  primaryEmail: string;
  status: string;
  statusReason: string | null;
  preferredLocale: string;
  createdAt: Date;
  memberships: AccountMembership[];
  roles: string[];
}

/** The caller's profile (app-side + Better Auth name), scoped to self. */
export async function getAccountProfile(
  appUserId: string,
  betterAuthUserId: string,
): Promise<AccountProfile | null> {
  const user = await db
    .selectFrom("app_users")
    .select(["id", "display_name", "primary_email", "created_at"])
    .where("id", "=", appUserId)
    .executeTakeFirst();
  if (!user) return null;

  const authUser = await db
    .selectFrom("user")
    .select(["name"])
    .where("id", "=", betterAuthUserId)
    .executeTakeFirst();

  return {
    appUserId: user.id,
    displayName: user.display_name,
    name: authUser?.name ?? null,
    primaryEmail: user.primary_email,
    createdAt: new Date(user.created_at as unknown as string | Date),
  };
}

/** The caller's locale/formatting preferences, scoped to self. */
export async function getAccountPreferences(appUserId: string): Promise<AccountPreferences> {
  const user = await db
    .selectFrom("app_users")
    .select(["preferred_locale"])
    .where("id", "=", appUserId)
    .executeTakeFirst();

  const prefs = await db
    .selectFrom("app_user_locale_preferences")
    .select(["locale", "time_zone", "date_format", "number_format_locale"])
    .where("app_user_id", "=", appUserId)
    .executeTakeFirst();

  return {
    preferredLocale: prefs?.locale ?? user?.preferred_locale ?? "en",
    timeZone: prefs?.time_zone ?? null,
    dateFormat: prefs?.date_format ?? null,
    numberFormatLocale: prefs?.number_format_locale ?? null,
  };
}

/** Read-only summary of the caller's account, scoped to self. */
export async function getAccountOverview(appUserId: string): Promise<AccountOverview | null> {
  const user = await db
    .selectFrom("app_users")
    .select([
      "display_name",
      "primary_email",
      "status",
      "status_reason",
      "preferred_locale",
      "created_at",
    ])
    .where("id", "=", appUserId)
    .executeTakeFirst();
  if (!user) return null;

  const memberships = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select([
      "m.organization_id",
      "o.name as organization_name",
      "o.slug as organization_slug",
      "m.status",
    ])
    .where("m.app_user_id", "=", appUserId)
    .orderBy("o.name", "asc")
    .execute();

  const roleRows = await db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_roles as r", "r.id", "ur.role_id")
    .select(["r.name as name"])
    .where("ur.app_user_id", "=", appUserId)
    .orderBy("r.name", "asc")
    .execute();

  return {
    displayName: user.display_name,
    primaryEmail: user.primary_email,
    status: user.status,
    statusReason: user.status_reason,
    preferredLocale: user.preferred_locale,
    createdAt: new Date(user.created_at as unknown as string | Date),
    memberships: memberships.map((m) => ({
      organizationId: m.organization_id,
      organizationName: m.organization_name,
      organizationSlug: m.organization_slug,
      status: m.status,
    })),
    roles: roleRows.map((r) => r.name),
  };
}
