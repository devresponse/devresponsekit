import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from "kysely";
import type * as MetricsModule from "@/lib/admin/metrics.server";

/**
 * The SQL the dashboard's daily series send (F-37), compiled by the real
 * Kysely Postgres compiler over a driver that runs nothing. The mapping and
 * zero-fill are covered in metrics-server.test.ts; the same queries run
 * against live Postgres in tests/db/dashboard-metrics-zone.db.test.ts.
 *
 * Pinned here, because each one fails only at runtime in Postgres:
 *   - the zone is a bind parameter in the bucket AND in the window's opening
 *     instant, so a "day" is the viewer's calendar day, not UTC's;
 *   - GROUP BY names the `day` output column: repeating the bucket expression
 *     would bind the zone twice, and Postgres rejects two parameters it cannot
 *     prove equal with 42803;
 *   - an offset zone goes as an INTERVAL (ISO sign), never as text, which
 *     Postgres would read POSIX-style with the sign inverted.
 */
const queries: CompiledQuery[] = [];

vi.mock("@/db/database", () => ({
  db: new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === "query") queries.push(event.query);
    },
  }),
}));

let m: typeof MetricsModule;
beforeEach(async () => {
  queries.length = 0;
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-17T20:00:00.000Z") });
  m = await import("@/lib/admin/metrics.server");
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

function only(): CompiledQuery {
  expect(queries).toHaveLength(1);
  return queries[0]!;
}

describe("daily series SQL (F-37)", () => {
  it("buckets and opens the window in the named zone, grouping by the output column", async () => {
    const series = await m.dailyRegistrations(undefined, { timeZone: "Asia/Kathmandu" });

    const { sql, parameters } = only();
    expect(sql).toContain(`to_char("created_at" at time zone $1::text, 'YYYY-MM-DD') as "day"`);
    expect(sql).toContain(`created_at >= ($2::timestamp at time zone $3::text)`);
    expect(sql).toMatch(/group by "day"$/);
    // 20:00 UTC on the 17th is 01:45 on the 18th in Kathmandu: the window is
    // the seven Kathmandu days ending on the 18th, opening at its midnight.
    expect(parameters).toEqual(["Asia/Kathmandu", "2026-06-12", "Asia/Kathmandu"]);
    expect(series.map((d) => d.date)).toEqual([
      "2026-06-12",
      "2026-06-13",
      "2026-06-14",
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
    ]);
  });

  it("keeps UTC days when no zone is named (the JSON API)", async () => {
    const series = await m.dailyAuditEvents();

    const { parameters } = only();
    expect(parameters).toEqual(["UTC", "2026-06-11", "UTC"]);
    expect(series.at(-1)?.date).toBe("2026-06-17");
  });

  it("sends an offset zone as an interval, in its canonical spelling", async () => {
    await m.dailyLogins("org-1", { timeZone: "+0545" });

    const { sql, parameters } = only();
    expect(sql).toContain(`at time zone $1::interval`);
    expect(sql).toContain(`at time zone $5::interval)`);
    expect(sql).not.toContain("::text");
    expect(parameters).toEqual(["+05:45", "org-1", "auth.session.created", "2026-06-12", "+05:45"]);
  });

  it("groups every daily series by the output column, never by a re-bound expression", async () => {
    const range = { timeZone: "America/Vancouver" };
    await m.dailyRegistrations(undefined, range);
    await m.dailyRegistrations("org-1", range);
    await m.dailyLogins(undefined, range);
    await m.dailyLogins("org-1", range);
    await m.dailyAuditEvents(range);

    expect(queries).toHaveLength(5);
    for (const { sql } of queries) {
      expect(sql).toMatch(/group by "day"$/);
      expect(sql.match(/to_char\(/g)).toHaveLength(1);
    }
  });

  it("opens the most-active-orgs window at the same zoned midnight", async () => {
    await m.signupsPerOrg({ timeZone: "Asia/Kathmandu" });

    const { sql, parameters } = only();
    expect(sql).toContain(`m.created_at >= ($1::timestamp at time zone $2::text)`);
    expect(parameters.slice(0, 2)).toEqual(["2026-06-12", "Asia/Kathmandu"]);
  });
});
