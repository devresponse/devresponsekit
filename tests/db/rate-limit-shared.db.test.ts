import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import {
  __resetSharedRateLimitForTests,
  consumeSharedToken,
  pruneStaleSharedBuckets,
  SHARED_STALE_AFTER_MS,
} from "@/lib/admin/rate-limit-shared.server";

/**
 * DB-BACKED tests for the shared pre-auth token bucket (review #98).
 *
 * The unit suite proves how a statement result is interpreted and the
 * fallback policy; only live Postgres proves the property the feature exists
 * for — that the budget is ONE budget no matter how many callers (instances)
 * consume it concurrently. The refill-and-consume is a single
 * `INSERT … ON CONFLICT DO UPDATE … WHERE refilled >= 1 RETURNING`, so N
 * parallel consumers on one key must yield exactly `capacity` allows, the
 * rest denied, and a balance that is never negative (0006's CHECK backs that).
 *
 * Time is injected (`nowMs`) so refill is deterministic; the keys use the
 * `__dbtest_` prefix and are removed here.
 */
const PREFIX = "__dbtest_rl_";
const key = (name: string) => `${PREFIX}${name}`;

async function cleanup(): Promise<void> {
  await db.deleteFrom("app_rate_limits").where("key", "like", `${PREFIX}%`).execute();
}

async function balance(name: string): Promise<{ tokens: number; updatedAt: Date } | null> {
  const row = await db
    .selectFrom("app_rate_limits")
    .select(["tokens", "updated_at"])
    .where("key", "=", key(name))
    .executeTakeFirst();
  return row ? { tokens: Number(row.tokens), updatedAt: row.updated_at } : null;
}

beforeAll(cleanup);
afterEach(() => {
  __resetSharedRateLimitForTests();
});
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("shared bucket — atomic refill-and-consume", () => {
  it("N concurrent consumers of one key: exactly `capacity` succeed, the rest are denied, balance ends at 0", async () => {
    const opts = { capacity: 20, refillPerSec: 1 };
    const now = Date.UTC(2026, 0, 1);
    // 60 callers on one pool — more than the pool's 10 connections, so real
    // conflicts + waits happen inside Postgres, not just in the JS event loop.
    const results = await Promise.all(
      Array.from({ length: 60 }, () => consumeSharedToken(key("burst"), opts, now)),
    );
    const allowed = results.filter((r) => r.ok).length;
    expect(allowed).toBe(20);
    expect(results.filter((r) => !r.ok)).toHaveLength(40);
    for (const r of results) if (!r.ok) expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((await balance("burst"))?.tokens).toBe(0);
  });

  it("refills proportionally to elapsed time, capped at capacity, and a deny writes nothing", async () => {
    const opts = { capacity: 2, refillPerSec: 1 };
    const t0 = Date.UTC(2026, 0, 2);
    expect((await consumeSharedToken(key("refill"), opts, t0)).ok).toBe(true);
    expect((await consumeSharedToken(key("refill"), opts, t0)).ok).toBe(true);
    const denied = await consumeSharedToken(key("refill"), opts, t0);
    expect(denied).toEqual({ ok: false, retryAfterSeconds: 1 });
    // The deny left the row exactly as the last allow wrote it.
    expect(await balance("refill")).toEqual({ tokens: 0, updatedAt: new Date(t0) });

    // Half a second later: 0.5 tokens — still denied, Retry-After rounds up to 1 s.
    expect(await consumeSharedToken(key("refill"), opts, t0 + 500)).toEqual({
      ok: false,
      retryAfterSeconds: 1,
    });
    // One full second later: one token refilled → allow, then deny again.
    expect((await consumeSharedToken(key("refill"), opts, t0 + 1_000)).ok).toBe(true);
    expect((await consumeSharedToken(key("refill"), opts, t0 + 1_000)).ok).toBe(false);

    // An hour later the bucket is full again but NOT over capacity.
    const later = t0 + 3_600_000;
    expect((await consumeSharedToken(key("refill"), opts, later)).ok).toBe(true);
    expect((await consumeSharedToken(key("refill"), opts, later)).ok).toBe(true);
    expect((await consumeSharedToken(key("refill"), opts, later)).ok).toBe(false);
  });

  it("a slow-refill deny reports the real wait, and a lagging clock's Retry-After clamps elapsed at 0", async () => {
    const opts = { capacity: 1, refillPerSec: 0.05 }; // 20 s per token
    const t0 = Date.UTC(2026, 0, 3);
    expect((await consumeSharedToken(key("slow"), opts, t0)).ok).toBe(true);
    expect(await consumeSharedToken(key("slow"), opts, t0 + 5_000)).toEqual({
      ok: false,
      retryAfterSeconds: 15,
    });
    // Deny path from an instance whose clock lags the last writer by 60 s:
    // the JS-side Retry-After clamps elapsed at 0, so the wait is the
    // one-token 20 s. Unclamped arithmetic would refill -3 tokens and report
    // 80 s. A deny writes nothing, so the row is exactly as the allow left it.
    expect(await consumeSharedToken(key("slow"), opts, t0 - 60_000)).toEqual({
      ok: false,
      retryAfterSeconds: 20,
    });
    expect(await balance("slow")).toEqual({ tokens: 0, updatedAt: new Date(t0) });
  });

  it("the clock never runs backwards: an allow from a lagging instance neither un-refills the bucket nor rewinds its timestamp", async () => {
    // The clamps only matter on an ALLOW from a NON-EMPTY bucket (a deny
    // writes nothing, so an empty bucket would pass with or without them —
    // review of #98). Capacity 5 at 1/s so half a second of lag is visible
    // in the balance.
    const opts = { capacity: 5, refillPerSec: 1 };
    const t0 = Date.UTC(2026, 0, 3, 12);
    expect((await consumeSharedToken(key("skew"), opts, t0)).ok).toBe(true);
    expect(await balance("skew")).toEqual({ tokens: 4, updatedAt: new Date(t0) });

    // 500 ms "earlier": unclamped SQL would refill -0.5 and leave 2.5; the
    // `greatest(0, …)` clamp leaves exactly 3, and `greatest(updated_at, …)`
    // keeps the stored clock at t0 instead of rewinding it to t0 - 500.
    expect((await consumeSharedToken(key("skew"), opts, t0 - 500)).ok).toBe(true);
    expect(await balance("skew")).toEqual({ tokens: 3, updatedAt: new Date(t0) });

    // Back on the true clock at t0: no refill is credited for the lag — the
    // balance is 2, not the 2.5 a rewound timestamp would have granted.
    expect((await consumeSharedToken(key("skew"), opts, t0)).ok).toBe(true);
    expect(await balance("skew")).toEqual({ tokens: 2, updatedAt: new Date(t0) });

    // Real time still refills from the (never-rewound) stored clock: +1 s → 3, consume → 2.
    expect((await consumeSharedToken(key("skew"), opts, t0 + 1_000)).ok).toBe(true);
    expect(await balance("skew")).toEqual({ tokens: 2, updatedAt: new Date(t0 + 1_000) });
  });

  it("isolates keys — one exhausted bucket does not affect another", async () => {
    const opts = { capacity: 1, refillPerSec: 1 };
    const t0 = Date.UTC(2026, 0, 4);
    expect((await consumeSharedToken(key("iso-a"), opts, t0)).ok).toBe(true);
    expect((await consumeSharedToken(key("iso-a"), opts, t0)).ok).toBe(false);
    expect((await consumeSharedToken(key("iso-b"), opts, t0)).ok).toBe(true);
  });

  it("the most recent caller's budget wins — a re-budgeted key is capped at the new capacity", async () => {
    const t0 = Date.UTC(2026, 0, 5);
    expect(
      (await consumeSharedToken(key("rebudget"), { capacity: 10, refillPerSec: 1 }, t0)).ok,
    ).toBe(true);
    expect((await balance("rebudget"))?.tokens).toBe(9);
    // Lowered to 3: the refill is capped at 3 and one is consumed.
    expect(
      (await consumeSharedToken(key("rebudget"), { capacity: 3, refillPerSec: 1 }, t0)).ok,
    ).toBe(true);
    expect((await balance("rebudget"))?.tokens).toBe(2);
  });
});

describe("shared bucket — housekeeping", () => {
  it("pruneStaleSharedBuckets deletes only keys idle past the stale window", async () => {
    const now = Date.UTC(2026, 0, 6, 12);
    // Start from an empty prefix: the earlier suites leave their rows behind.
    await cleanup();
    // Seed the rows directly rather than via consumeSharedToken: a consume
    // fires the opportunistic fire-and-forget prune, which would race this
    // test's own prune (the stale row vanished before the `before` check in
    // CI). The explicit call below is the only prune that runs here.
    await db
      .insertInto("app_rate_limits")
      .values([
        { key: key("stale"), tokens: 4, updated_at: new Date(now - SHARED_STALE_AFTER_MS - 1) },
        {
          key: key("fresh"),
          tokens: 4,
          updated_at: new Date(now - SHARED_STALE_AFTER_MS + 60_000),
        },
        { key: key("live"), tokens: 4, updated_at: new Date(now) },
      ])
      .execute();
    // Other suites' / production rows are never touched by our count check:
    // assert on OUR keys only.
    const before = await db
      .selectFrom("app_rate_limits")
      .select("key")
      .where("key", "like", `${PREFIX}%`)
      .execute();
    expect(before.map((r) => r.key).sort()).toEqual(
      [key("fresh"), key("live"), key("stale")].sort(),
    );

    await pruneStaleSharedBuckets(now);

    expect(await balance("stale")).toBeNull();
    expect(await balance("fresh")).not.toBeNull();
    expect(await balance("live")).not.toBeNull();
  });

  it("the table refuses a negative balance (0006 CHECK) — the statement can never take the bucket below zero", async () => {
    await expect(
      db
        .insertInto("app_rate_limits")
        .values({ key: key("negative"), tokens: -1, updated_at: new Date() })
        .execute(),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
