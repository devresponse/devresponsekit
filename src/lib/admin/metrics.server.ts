import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { LOGIN_EVENT_TYPE } from "@/lib/auth-login-audit.server";

/**
 * Dashboard reporting metrics — read-only aggregates over `app_*` data.
 *
 * Every query is bounded (a `days`-day window, top-N orgs), parameterized,
 * and runs against existing indexes (`app_users.created_at`,
 * `app_audit_events (event_type, created_at)`). The per-day grouped counts are
 * zero-filled onto a complete day spine in JS so a 7-day chart always has 7
 * bars even when some days have no data.
 *
 * A "day" is a calendar day in the window's time zone ({@link DayWindow}):
 * UTC unless the caller names one. The Administrator overview passes the
 * viewer's saved zone (F-37), so its daily charts count the same days, and
 * put "today" at the same moment, as the activity lists beside them, which
 * the app formatter shows in that zone. The JSON API
 * (`GET /api/administrator/metrics`) keeps UTC days.
 *
 * Authorization is the caller's responsibility (the route/page): system-wide
 * series are SUPERADMIN-only; org-scoped series take the org admin's
 * `organizationId`.
 */

export interface DailyCount {
  /** `YYYY-MM-DD`: a calendar day in the window's zone (UTC by default). */
  date: string;
  count: number;
}

export interface OrgSignupCount {
  organizationId: string;
  name: string;
  count: number;
}

/** The reporting window: how many days, and whose calendar they are. */
export interface DayWindow {
  /** Days in the window, today included. Default {@link DEFAULT_WINDOW_DAYS}. */
  days?: number;
  /** IANA zone whose calendar days are counted. Default `"UTC"`. */
  timeZone?: string;
}

export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_TOP_ORGS = 10;

/* ----------------------------- date helpers ----------------------------- */

/** An ISO-8601 offset zone as ICU spells it (`"+05:45"`). */
const OFFSET_ZONE = /^[+-]\d{2}:\d{2}$/;

/**
 * `timeZone`, checked against this runtime's ICU: an offset zone gets its one
 * spelling (`"+0545"` → `"+05:45"`, see {@link zoneSql}); a named zone is kept
 * as given, since Postgres knows current and legacy names alike (ICU would
 * rename `Asia/Kathmandu` to `Asia/Katmandu`). A zone ICU does not know
 * becomes UTC; callers pass zones `resolveFormatPreferences` already
 * validated, so that is only a guard.
 */
export function canonicalTimeZone(timeZone: string): string {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    return OFFSET_ZONE.test(resolved) ? resolved : timeZone;
  } catch {
    return "UTC";
  }
}

/** `YYYY-MM-DD`: the calendar day `now` falls on in `timeZone`. */
export function calendarDayIn(now: Date, timeZone: string): string {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const part of format.formatToParts(now)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** `YYYY-MM-DD` for each day in the window, oldest → today, in `timeZone`. */
export function daySpine(days: number, now: Date = new Date(), timeZone = "UTC"): string[] {
  // Calendar arithmetic on the DATE: the zone only decides which day "today" is.
  const today = new Date(`${calendarDayIn(now, timeZone)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

/** Maps grouped `{ day, count }` rows onto the full spine, filling gaps with 0. */
export function fillSpine(
  spine: readonly string[],
  rows: ReadonlyArray<{ day: string; count: number | string }>,
): DailyCount[] {
  const byDay = new Map(rows.map((r) => [r.day, Number(r.count)]));
  return spine.map((date) => ({ date, count: byDay.get(date) ?? 0 }));
}

/**
 * The zone as Postgres must read it. Postgres takes a numeric zone string
 * POSIX-style, positive WEST of Greenwich, so `'+05:45'` would count Nepal's
 * days as UTC-5:45; ICU, and the app formatter, read it ISO-style. As an
 * INTERVAL Postgres uses the ISO sign, so an offset zone goes as one. A named
 * zone goes as text (Postgres matches names case-insensitively, links
 * included).
 */
function zoneSql(timeZone: string) {
  return OFFSET_ZONE.test(timeZone) ? sql`${timeZone}::interval` : sql`${timeZone}::text`;
}

/** SQL day bucket for a `timestamptz` column: its calendar day in `timeZone`, `YYYY-MM-DD`. */
function dayBucket(column: string, timeZone: string) {
  return sql<string>`to_char(${sql.ref(column)} at time zone ${zoneSql(timeZone)}, 'YYYY-MM-DD')`;
}

/**
 * The window for one query: its spine and the SQL instant it opens at
 * (midnight of the first day in the zone, computed by Postgres, which also
 * resolves a DST change at midnight). The instant is a constant, so the `created_at`
 * index still serves the range. One `now` feeds both, so the rows and the
 * spine cannot straddle a midnight between them.
 */
function openWindow(range: DayWindow = {}) {
  const days = range.days ?? DEFAULT_WINDOW_DAYS;
  const timeZone = canonicalTimeZone(range.timeZone ?? "UTC");
  const spine = daySpine(days, new Date(), timeZone);
  const since = sql<Date>`(${spine[0]}::timestamp at time zone ${zoneSql(timeZone)})`;
  return { timeZone, spine, since };
}

const COUNT = sql<number>`count(*)::int`;

/* -------------------------------- metrics ------------------------------- */

// Every daily query GROUPs BY the output column `day`, not by repeating the
// bucket expression: the zone is a bind parameter, and Postgres cannot tell
// that `$1` in SELECT and `$4` in GROUP BY are the same value, so a repeated
// expression fails with 42803 ("must appear in the GROUP BY clause").

/**
 * Daily user registrations over the window. System-wide (new `app_users`)
 * when `organizationId` is omitted; otherwise new memberships in that org.
 */
export async function dailyRegistrations(
  organizationId?: string,
  range?: DayWindow,
): Promise<DailyCount[]> {
  const { timeZone, spine, since } = openWindow(range);
  const rows = organizationId
    ? await db
        .selectFrom("app_organization_memberships")
        .select([dayBucket("created_at", timeZone).as("day"), COUNT.as("count")])
        .where("organization_id", "=", organizationId)
        .where(sql<boolean>`created_at >= ${since}`)
        .groupBy("day")
        .execute()
    : await db
        .selectFrom("app_users")
        .select([dayBucket("created_at", timeZone).as("day"), COUNT.as("count")])
        .where(sql<boolean>`created_at >= ${since}`)
        .groupBy("day")
        .execute();
  return fillSpine(spine, rows);
}

/**
 * Daily logins over the window (one per session creation; refreshes don't
 * count). System-wide when `organizationId` is omitted; otherwise logins by
 * users who hold a membership in that org (a multi-org user's login counts
 * for each of their orgs).
 */
export async function dailyLogins(
  organizationId?: string,
  range?: DayWindow,
): Promise<DailyCount[]> {
  const { timeZone, spine, since } = openWindow(range);
  const rows = organizationId
    ? await db
        .selectFrom("app_audit_events as ae")
        .innerJoin("app_users as u", "u.better_auth_user_id", "ae.actor_better_auth_user_id")
        .innerJoin("app_organization_memberships as m", (join) =>
          join.onRef("m.app_user_id", "=", "u.id").on("m.organization_id", "=", organizationId),
        )
        .select([dayBucket("ae.created_at", timeZone).as("day"), COUNT.as("count")])
        .where("ae.event_type", "=", LOGIN_EVENT_TYPE)
        .where(sql<boolean>`ae.created_at >= ${since}`)
        .groupBy("day")
        .execute()
    : await db
        .selectFrom("app_audit_events")
        .select([dayBucket("created_at", timeZone).as("day"), COUNT.as("count")])
        .where("event_type", "=", LOGIN_EVENT_TYPE)
        .where(sql<boolean>`created_at >= ${since}`)
        .groupBy("day")
        .execute();
  return fillSpine(spine, rows);
}

/**
 * Daily count of ALL audit events across every organization over the window —
 * total audit volume, NOT filtered by event type (unlike {@link dailyLogins}).
 * System-wide only: there is no org-scoped variant, so the call site must keep
 * this SUPERADMIN-only. Runs on the `app_audit_events (created_at)` index.
 */
export async function dailyAuditEvents(range?: DayWindow): Promise<DailyCount[]> {
  const { timeZone, spine, since } = openWindow(range);
  const rows = await db
    .selectFrom("app_audit_events")
    .select([dayBucket("created_at", timeZone).as("day"), COUNT.as("count")])
    .where(sql<boolean>`created_at >= ${since}`)
    .groupBy("day")
    .execute();
  return fillSpine(spine, rows);
}

/**
 * Most active organizations by new signups (memberships created) in the
 * window — cross-org, so SUPERADMIN-only at the call site. Ties broken by
 * name for a stable order.
 */
export async function signupsPerOrg(
  range?: DayWindow,
  limit: number = DEFAULT_TOP_ORGS,
): Promise<OrgSignupCount[]> {
  const { since } = openWindow(range);
  const rows = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select(["m.organization_id as organizationId", "o.name as name", COUNT.as("count")])
    .where(sql<boolean>`m.created_at >= ${since}`)
    .groupBy(["m.organization_id", "o.name"])
    .orderBy("count", "desc")
    .orderBy("o.name", "asc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    organizationId: r.organizationId,
    name: r.name,
    count: Number(r.count),
  }));
}
