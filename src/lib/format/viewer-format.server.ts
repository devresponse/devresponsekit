import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { getSessionCookie } from "better-auth/cookies";
import {
  createAppFormatter,
  resolveFormatPreferences,
  systemFormatPreferences,
  type AppFormatter,
  type FormatPreferences,
} from "@/lib/format/app-format";

/**
 * The deployment's own zone: the server runtime's (UTC on Vercel; set `TZ` to
 * change it). It is what "System default" means for a time zone, and it is
 * the zone next-intl itself falls back to, so every signed-out page, and
 * every user who saved no zone, sees one zone on the server and the client.
 */
export function deploymentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The signed-in viewer's display preferences (F-37), resolved once per request.
 *
 * Read by next-intl's request config (`src/i18n/request.ts`, which hands the
 * zone to every server and client formatter), by the root layout (which hands
 * the date and number format to the client provider) and by
 * {@link getAppFormatter}. React `cache()` makes those one lookup.
 *
 * Cost and failure rules, because this runs for EVERY page, public ones
 * included:
 *   - No Better Auth session cookie → the deployment defaults, with no
 *     session read and no query. A signed-out page never touches the DB here,
 *     and the auth graph is imported lazily so it is not loaded for one.
 *   - With a cookie, the session comes from `getCurrentSession`, which is
 *     memoized per request and is the read every secure guard already makes,
 *     so a secure page pays one extra indexed query (the preferences row).
 *   - Any failure (the DB is down, the session read throws, a call outside a
 *     request) falls back to the defaults and is logged. A formatting
 *     preference must never be the reason a page fails to render. Next's own
 *     control-flow errors (a dynamic-rendering bailout, a redirect) are
 *     re-thrown untouched.
 *
 * An impersonation session reads the TARGET user's preferences: the
 * impersonator sees the dates the user sees, which is what the support flow
 * is for.
 */
export const getViewerFormatPreferences = cache(async (): Promise<FormatPreferences> => {
  const defaults = systemFormatPreferences(deploymentTimeZone());
  try {
    const requestHeaders = await headers();
    if (!getSessionCookie(requestHeaders)) return defaults;

    const { getCurrentSession } = await import("@/lib/auth-guard");
    const session = await getCurrentSession();
    if (!session) return defaults;

    const { db } = await import("@/db/database");
    const row = await db
      .selectFrom("app_users as u")
      .leftJoin("app_user_locale_preferences as p", "p.app_user_id", "u.id")
      .select(["p.time_zone", "p.date_format", "p.number_format_locale"])
      .where("u.better_auth_user_id", "=", session.user.id)
      .executeTakeFirst();
    return resolveFormatPreferences(row, defaults.timeZone);
  } catch (error) {
    unstable_rethrow(error);
    const { logServerError } = await import("@/lib/observability/logger.server");
    logServerError("viewer format preferences lookup failed; using defaults", { err: error });
    return defaults;
  }
});

/**
 * The server-side formatter for a server component (F-37). Same code and
 * same inputs as the client's `useAppFormatter`, so a timestamp rendered on
 * the server matches one rendered in the browser.
 */
export async function getAppFormatter(locale: string): Promise<AppFormatter> {
  return createAppFormatter(locale, await getViewerFormatPreferences());
}
