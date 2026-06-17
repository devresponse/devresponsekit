import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { LOGIN_EVENT_TYPE } from "@/lib/auth-login-audit.server";

/**
 * Dashboard reporting metrics — read-only aggregates over `app_*` data.
 *
 * Every query is bounded (a `days`-day window, top-N orgs), parameterized,
 * and runs against existing indexes (`app_users.created_at`,
 * `app_audit_events (event_type, created_at)`). Day buckets are UTC. The
 * per-day grouped counts are zero-filled onto a complete day spine in JS so a
 * 7-day chart always has 7 bars even when some days have no data.
 *
 * Authorization is the caller's responsibility (the route/page): system-wide
 * series are SUPERADMIN-only; org-scoped series take the org admin's
 * `organizationId`.
 */

export interface DailyCount {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  count: number;
}

export interface OrgSignupCount {
  organizationId: string;
  name: string;
  count: number;
}

export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_TOP_ORGS = 10;

/* ----------------------------- date helpers ----------------------------- */

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Inclusive start of the window: midnight UTC, `days - 1` days before today. */
export function windowStart(days: number, now: Date = new Date()): Date {
  const start = utcMidnight(now);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

/** `YYYY-MM-DD` (UTC) for each day in the window, oldest → today. */
export function daySpine(days: number, now: Date = new Date()): string[] {
  const start = windowStart(days, now);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** Maps grouped `{ day, count }` rows onto the full spine, filling gaps with 0. */
export function fillSpine(
  days: number,
  rows: ReadonlyArray<{ day: string; count: number }>,
  now?: Date,
): DailyCount[] {
  const byDay = new Map(rows.map((r) => [r.day, r.count]));
  return daySpine(days, now).map((date) => ({ date, count: byDay.get(date) ?? 0 }));
}

/** SQL day bucket for a `timestamptz` column, normalized to a UTC `YYYY-MM-DD`. */
function dayBucket(column: string) {
  return sql<string>`to_char(date_trunc('day', ${sql.ref(column)} at time zone 'UTC'), 'YYYY-MM-DD')`;
}
const COUNT = sql<number>`count(*)::int`;

/* -------------------------------- metrics ------------------------------- */

/**
 * Daily user registrations over the window. System-wide (new `app_users`)
 * when `organizationId` is omitted; otherwise new memberships in that org.
 */
export async function dailyRegistrations(
  organizationId?: string,
  days: number = DEFAULT_WINDOW_DAYS,
): Promise<DailyCount[]> {
  const since = windowStart(days);
  const rows = organizationId
    ? await db
        .selectFrom("app_organization_memberships")
        .select([dayBucket("created_at").as("day"), COUNT.as("count")])
        .where("organization_id", "=", organizationId)
        .where(sql<boolean>`created_at >= ${since}`)
        .groupBy(dayBucket("created_at"))
        .execute()
    : await db
        .selectFrom("app_users")
        .select([dayBucket("created_at").as("day"), COUNT.as("count")])
        .where(sql<boolean>`created_at >= ${since}`)
        .groupBy(dayBucket("created_at"))
        .execute();
  return fillSpine(
    days,
    rows.map((r) => ({ day: r.day, count: Number(r.count) })),
  );
}

/**
 * Daily logins over the window (one per session creation; refreshes don't
 * count). System-wide when `organizationId` is omitted; otherwise logins by
 * users who hold a membership in that org (a multi-org user's login counts
 * for each of their orgs).
 */
export async function dailyLogins(
  organizationId?: string,
  days: number = DEFAULT_WINDOW_DAYS,
): Promise<DailyCount[]> {
  const since = windowStart(days);
  const rows = organizationId
    ? await db
        .selectFrom("app_audit_events as ae")
        .innerJoin("app_users as u", "u.better_auth_user_id", "ae.actor_better_auth_user_id")
        .innerJoin("app_organization_memberships as m", (join) =>
          join.onRef("m.app_user_id", "=", "u.id").on("m.organization_id", "=", organizationId),
        )
        .select([dayBucket("ae.created_at").as("day"), COUNT.as("count")])
        .where("ae.event_type", "=", LOGIN_EVENT_TYPE)
        .where(sql<boolean>`ae.created_at >= ${since}`)
        .groupBy(dayBucket("ae.created_at"))
        .execute()
    : await db
        .selectFrom("app_audit_events")
        .select([dayBucket("created_at").as("day"), COUNT.as("count")])
        .where("event_type", "=", LOGIN_EVENT_TYPE)
        .where(sql<boolean>`created_at >= ${since}`)
        .groupBy(dayBucket("created_at"))
        .execute();
  return fillSpine(
    days,
    rows.map((r) => ({ day: r.day, count: Number(r.count) })),
  );
}

/**
 * Most active organizations by new signups (memberships created) in the
 * window — cross-org, so SUPERADMIN-only at the call site. Ties broken by
 * name for a stable order.
 */
export async function signupsPerOrg(
  days: number = DEFAULT_WINDOW_DAYS,
  limit: number = DEFAULT_TOP_ORGS,
): Promise<OrgSignupCount[]> {
  const since = windowStart(days);
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
