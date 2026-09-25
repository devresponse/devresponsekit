import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { LOGIN_EVENT_TYPE } from "@/lib/auth-login-audit.server";
import {
  dailyAuditEvents,
  dailyLogins,
  dailyRegistrations,
  signupsPerOrg,
  type DailyCount,
} from "@/lib/admin/metrics.server";

/**
 * DB-BACKED test for the Administrator overview's daily charts (F-37 review).
 *
 * The overview's activity lists show each time in the viewer's saved zone, so
 * its daily charts must count calendar days in that zone too: before this, the
 * SQL bucketed by UTC day, and for the first 5h45m of every Kathmandu day the
 * "today" bar still said yesterday. The unit suites compile the SQL but run
 * none of it; this runs it against live Postgres (`pnpm test:db`) and pins:
 *   - the day bucket AND the window's opening instant follow the zone;
 *   - `+05:45` means east of Greenwich (Postgres reads a numeric zone STRING
 *     the other way round, so it has to go as an interval);
 *   - the zone is a bind parameter everywhere and the queries still run
 *     (grouping by a repeated parameterized expression fails with 42803).
 *
 * `Date` is frozen at a moment in 2030 (only `Date`: the pg pool's timers stay
 * real), so the windows are fixed and no seeded row falls inside them.
 * Fixtures use the `__dbtest_` prefix and self-clean.
 */
const PREFIX = "__dbtest_metricszone_";

// 20:00 UTC on the 17th is 01:45 on the 18th in Kathmandu (UTC+5:45) and
// 13:00 on the 17th in Vancouver (UTC-7 in June).
const NOW = new Date("2030-06-17T20:00:00.000Z");

/** Each fixture instant, and the day it falls on in each zone. */
const EVENTS = [
  { at: "2030-06-17T18:30:00Z", utc: "06-17", kathmandu: "06-18", vancouver: "06-17" },
  { at: "2030-06-17T18:00:00Z", utc: "06-17", kathmandu: "06-17", vancouver: "06-17" },
  { at: "2030-06-17T03:00:00Z", utc: "06-17", kathmandu: "06-17", vancouver: "06-16" },
  // Kathmandu's window opens at 2030-06-11T18:15Z (midnight on the 12th there).
  { at: "2030-06-11T18:30:00Z", utc: "06-11", kathmandu: "06-12", vancouver: "06-11" },
  { at: "2030-06-11T18:00:00Z", utc: "06-11", kathmandu: null, vancouver: "06-11" },
] as const;

let orgId = "";

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "like", `${PREFIX}%`)
      .execute();
  });
  await db
    .deleteFrom("app_organization_memberships")
    .where("organization_id", "in", (eb) =>
      eb.selectFrom("app_organizations").select("id").where("slug", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

beforeAll(async () => {
  await cleanup();
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org`, name: `${PREFIX}Org` })
    .returning("id")
    .executeTakeFirstOrThrow();
  orgId = org.id;

  for (const [i, event] of EVENTS.entries()) {
    const betterAuthUserId = `${PREFIX}ba_${i}`;
    const user = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: betterAuthUserId,
        primary_email: `${PREFIX}${i}@dbtest.local`,
        status: "active",
        created_at: sql`${event.at}::timestamptz`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("app_organization_memberships")
      .values({
        organization_id: orgId,
        app_user_id: user.id,
        status: "active",
        created_at: sql`${event.at}::timestamptz`,
      })
      .execute();
    await db
      .insertInto("app_audit_events")
      .values({
        event_type: LOGIN_EVENT_TYPE,
        outcome: "success",
        actor_better_auth_user_id: betterAuthUserId,
        metadata: JSON.stringify({}),
        created_at: sql`${event.at}::timestamptz`,
      })
      .execute();
  }
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

/** The expected 7-day series: every spine day, with the fixture counts. */
function expected(spine: string[], zone: "utc" | "kathmandu" | "vancouver"): DailyCount[] {
  return spine.map((day) => ({
    date: `2030-${day}`,
    count: EVENTS.filter((e) => e[zone] === day).length,
  }));
}

const UTC_SPINE = ["06-11", "06-12", "06-13", "06-14", "06-15", "06-16", "06-17"];
const KATHMANDU_SPINE = ["06-12", "06-13", "06-14", "06-15", "06-16", "06-17", "06-18"];

describe("daily series count calendar days in the requested zone (F-37)", () => {
  it("UTC by default: the JSON API's days", async () => {
    expect(await dailyRegistrations(orgId)).toEqual(expected(UTC_SPINE, "utc"));
  });

  it("Asia/Kathmandu: today is already the 18th, and the window opens at its midnight", async () => {
    const series = await dailyRegistrations(orgId, { timeZone: "Asia/Kathmandu" });
    expect(series).toEqual(expected(KATHMANDU_SPINE, "kathmandu"));
    // 18:00Z on the 11th is 23:45 on the 11th in Kathmandu: before the window.
    expect(series.reduce((n, d) => n + d.count, 0)).toBe(4);
  });

  it("an offset zone means east of Greenwich, as in Intl", async () => {
    expect(await dailyRegistrations(orgId, { timeZone: "+05:45" })).toEqual(
      expected(KATHMANDU_SPINE, "kathmandu"),
    );
  });

  it("America/Vancouver: a UTC-early instant lands on the previous day", async () => {
    expect(await dailyRegistrations(orgId, { timeZone: "America/Vancouver" })).toEqual(
      expected(UTC_SPINE, "vancouver"),
    );
  });

  it("org-scoped logins bucket the same way", async () => {
    expect(await dailyLogins(orgId, { timeZone: "Asia/Kathmandu" })).toEqual(
      expected(KATHMANDU_SPINE, "kathmandu"),
    );
  });

  it("the system-wide series run with a zone parameter", async () => {
    const range = { timeZone: "Asia/Kathmandu" };
    for (const series of [
      await dailyRegistrations(undefined, range),
      await dailyLogins(undefined, range),
      await dailyAuditEvents(range),
    ]) {
      expect(series.map((d) => d.date)).toEqual(KATHMANDU_SPINE.map((d) => `2030-${d}`));
      // Our fixtures are in there; other data in the database may be too.
      expect(series.find((d) => d.date === "2030-06-18")?.count).toBeGreaterThanOrEqual(1);
    }
  });

  it("most-active orgs count signups from the zone's window opening", async () => {
    const utc = await signupsPerOrg();
    const kathmandu = await signupsPerOrg({ timeZone: "Asia/Kathmandu" });
    expect(utc.find((o) => o.organizationId === orgId)?.count).toBe(5);
    expect(kathmandu.find((o) => o.organizationId === orgId)?.count).toBe(4);
  });
});
