import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MetricsModule from "@/lib/admin/metrics.server";

/**
 * Unit tests for the dashboard metrics layer. The pure date-spine / zero-fill
 * helpers are tested deterministically with a fixed `now`; the query
 * functions are exercised against a chainable `db` mock that returns canned
 * grouped rows (verifying the row→typed mapping and the spine fill, not the
 * SQL itself — that is covered against a real database in the browser job).
 */
const execute = vi.fn();

// Generic chainable Kysely stub: every builder method returns the chain and
// invokes any callback arg (the join `(j) => j.onRef().on()` form); `execute`
// resolves to the canned rows.
function chain(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "execute") return execute;
        return (...args: unknown[]) => {
          for (const a of args) {
            if (typeof a === "function") {
              try {
                (a as (x: unknown) => unknown)(chain());
              } catch {
                /* join-callback stub */
              }
            }
          }
          return chain();
        };
      },
    },
  );
}
vi.mock("@/db/database", () => ({ db: { selectFrom: () => chain() } }));

let m: typeof MetricsModule;
beforeEach(async () => {
  execute.mockReset();
  m = await import("@/lib/admin/metrics.server");
});
afterEach(() => vi.resetModules());

const NOW = new Date("2026-06-17T09:30:00.000Z");

describe("date helpers", () => {
  it("windowStart is midnight UTC, days-1 before today", () => {
    expect(m.windowStart(7, NOW).toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });

  it("daySpine lists each UTC day oldest → today", () => {
    expect(m.daySpine(7, NOW)).toEqual([
      "2026-06-11",
      "2026-06-12",
      "2026-06-13",
      "2026-06-14",
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
    ]);
  });

  it("fillSpine zero-fills missing days and keeps provided counts", () => {
    const filled = m.fillSpine(
      7,
      [
        { day: "2026-06-17", count: 5 },
        { day: "2026-06-13", count: 2 },
      ],
      NOW,
    );
    expect(filled).toHaveLength(7);
    expect(filled.find((d) => d.date === "2026-06-17")?.count).toBe(5);
    expect(filled.find((d) => d.date === "2026-06-13")?.count).toBe(2);
    expect(filled.find((d) => d.date === "2026-06-12")?.count).toBe(0);
  });
});

describe("query functions (mapping + fill over a mocked db)", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("dailyRegistrations returns a full 7-day series with numeric counts", async () => {
    execute.mockResolvedValue([{ day: today, count: "4" }]); // pg may return count as string
    const series = await m.dailyRegistrations();
    expect(series).toHaveLength(7);
    expect(series.find((d) => d.date === today)?.count).toBe(4);
    expect(series.every((d) => typeof d.count === "number")).toBe(true);
  });

  it("dailyRegistrations accepts an org id (org-scoped branch)", async () => {
    execute.mockResolvedValue([]);
    const series = await m.dailyRegistrations("org-1");
    expect(series).toHaveLength(7);
    expect(series.every((d) => d.count === 0)).toBe(true);
  });

  it("dailyLogins covers both system and org-scoped branches", async () => {
    execute.mockResolvedValue([{ day: today, count: 2 }]);
    expect(await m.dailyLogins()).toHaveLength(7);
    expect((await m.dailyLogins("org-1")).find((d) => d.date === today)?.count).toBe(2);
  });

  it("dailyAuditEvents returns a full system-wide 7-day series with numeric counts", async () => {
    execute.mockResolvedValue([{ day: today, count: "8" }]); // pg may return count as string
    const series = await m.dailyAuditEvents();
    expect(series).toHaveLength(7);
    expect(series.find((d) => d.date === today)?.count).toBe(8);
    expect(series.every((d) => typeof d.count === "number")).toBe(true);
  });

  it("signupsPerOrg maps rows to typed org counts", async () => {
    execute.mockResolvedValue([
      { organizationId: "o-1", name: "Acme", count: "9" },
      { organizationId: "o-2", name: "Beta", count: 3 },
    ]);
    const orgs = await m.signupsPerOrg();
    expect(orgs).toEqual([
      { organizationId: "o-1", name: "Acme", count: 9 },
      { organizationId: "o-2", name: "Beta", count: 3 },
    ]);
  });
});
