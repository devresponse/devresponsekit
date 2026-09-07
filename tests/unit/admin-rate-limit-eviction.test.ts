import { beforeEach, describe, expect, it } from "vitest";
import {
  __RATE_LIMIT_EVICTION_CONSTANTS_FOR_TESTS,
  __rateLimitBucketCountForTests,
  __rateLimitBucketKeysForTests,
  __resetRateLimitForTests,
  consumeToken,
  normalizeBucketKey,
  rateLimitKey,
} from "@/lib/admin/rate-limit.server";

/**
 * Review #223 — the in-memory bucket store's eviction policy.
 *
 * The old policy walked the ENTIRE map on every `consume` once it held more
 * than 1000 entries, and had no hard cap: an actor able to mint distinct keys
 * made every other actor's request pay an O(n) sweep, and the map grew
 * unbounded between sweeps.
 *
 * These tests pin the replacement by OBSERVING THE STORE ITSELF, not just
 * token budgets. That distinction is the point: an earlier version of this
 * file asserted only budgets, and every assertion held identically with the
 * cap, the LRU victim selection and the bounded stale sweep all deleted — the
 * fix was shipped without a regression test for the attack. Each test below
 * therefore names the mutation it kills:
 *   - the hard cap (map size after a flood of MAX_BUCKETS + N distinct keys);
 *   - LRU victim selection (the idle actor is the one evicted, the active one
 *     is retained — a discriminating pair, so evicting the wrong end fails);
 *   - bounded stale retirement (exactly MAX_EVICTIONS_PER_CONSUME entries per
 *     call, so both "no retirement" and "full sweep" fail);
 *   - the key-length bound on what the map actually stores.
 *
 * (The pre-auth floors — where an attacker, not an authenticated actor,
 * chooses the fan-out — moved to the Postgres-backed bucket in #98/#412; what
 * is left in this map is the authenticated per-actor tier.)
 */
const LIMIT = { capacity: 5, refillPerSec: 1 };
/**
 * A no-refill budget for the retirement tests. With `refillPerSec: 1` the
 * ~600 s stale window refills any bucket to capacity, so a retired bucket and
 * a retained one look identical and the assertion proves nothing (that was
 * the old bug in this file). At 0 tokens/sec, a RETAINED bucket keeps its
 * depleted count and only a RETIRED one starts fresh.
 */
const NO_REFILL = { capacity: 5, refillPerSec: 0 };
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

/**
 * Mirrors of the implementation constants. Deliberately literal rather than
 * imported: a test that reads `MAX_BUCKETS` from the module under test cannot
 * fail when someone raises it to 10_000_000 (the "no effective cap" mutation).
 * The first test below asserts the implementation still agrees with these
 * mirrors, so a deliberate change fails loudly here instead of silently
 * widening every other assertion.
 */
const MAX_BUCKETS = 10_000;
const STALE_AFTER_MS = 10 * 60 * 1000;
const MAX_EVICTIONS_PER_CONSUME = 8;
const MAX_KEY_LENGTH = 128;

beforeEach(() => {
  __resetRateLimitForTests();
});

describe("eviction constants", () => {
  it("still match the values these tests assume", () => {
    expect(__RATE_LIMIT_EVICTION_CONSTANTS_FOR_TESTS).toEqual({
      MAX_BUCKETS,
      STALE_AFTER_MS,
      MAX_EVICTIONS_PER_CONSUME,
      MAX_KEY_LENGTH,
    });
  });
});

describe("bucket key normalization", () => {
  it("stores realistic keys verbatim", () => {
    const key = rateLimitKey("admin.mutation", "3f1c2b7e-2a1d-4c9f-8f7a-9b0e1d2c3a4b");
    expect(normalizeBucketKey(key)).toBe(key);
  });

  it("keeps a 128-character key verbatim and folds a 129-character one", () => {
    const at = "a".repeat(MAX_KEY_LENGTH);
    expect(normalizeBucketKey(at)).toBe(at);
    const over = "a".repeat(MAX_KEY_LENGTH + 1);
    const folded = normalizeBucketKey(over);
    expect(folded).not.toBe(over);
    // 32-char readable prefix + '#' + 64 hex chars of SHA-256.
    expect(folded).toHaveLength(32 + 1 + 64);
    expect(folded.startsWith("a".repeat(32))).toBe(true);
  });

  it("is deterministic and keeps distinct long keys distinct", () => {
    const a = `scope:${"x".repeat(500)}A`;
    const b = `scope:${"x".repeat(500)}B`;
    expect(normalizeBucketKey(a)).toBe(normalizeBucketKey(a));
    expect(normalizeBucketKey(a)).not.toBe(normalizeBucketKey(b));
  });

  it("keeps two long keys on separate budgets through consumeToken", () => {
    const a = `scope:${"x".repeat(500)}A`;
    const b = `scope:${"x".repeat(500)}B`;
    for (let i = 0; i < LIMIT.capacity; i++) {
      expect(consumeToken(a, LIMIT, NOW).ok).toBe(true);
    }
    expect(consumeToken(a, LIMIT, NOW).ok).toBe(false);
    // b's budget is untouched.
    expect(consumeToken(b, LIMIT, NOW).ok).toBe(true);
  });

  it("keeps a long key's own budget across calls (the fold is stable)", () => {
    const key = `scope:${"y".repeat(400)}`;
    for (let i = 0; i < LIMIT.capacity; i++) {
      expect(consumeToken(key, LIMIT, NOW).ok).toBe(true);
    }
    expect(consumeToken(key, LIMIT, NOW).ok).toBe(false);
  });

  /**
   * The memory half of #223: budgets alone cannot see this, because a raw
   * hostile key is also stable and also distinct. Killing
   * `normalizeBucketKey` in `consumeToken` — letting the map store the
   * attacker's 5 KB key verbatim — must fail HERE.
   */
  it("never stores a hostile key at its full length", () => {
    const hostile = `admin.mutation:${"z".repeat(5_000)}`;
    consumeToken(hostile, LIMIT, NOW);
    const stored = __rateLimitBucketKeysForTests();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe(hostile);

    // A whole hostile key space stays bounded by the ENTRY COUNT alone.
    for (let i = 0; i < 100; i++) {
      consumeToken(`${hostile}:${i}`, LIMIT, NOW);
    }
    const lengths = __rateLimitBucketKeysForTests().map((key) => key.length);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(MAX_KEY_LENGTH);
  });
});

describe("hostile key space (review #223)", () => {
  it("never exceeds the hard cap, however many distinct keys arrive", () => {
    // Every key is fresh (same `now`), so nothing is stale-retired: the cap
    // is the only thing holding the map down. Without it the map would hold
    // all 12_500 entries.
    for (let i = 0; i < MAX_BUCKETS + 2_500; i++) {
      consumeToken(`flood:${i}`, LIMIT, NOW);
    }
    expect(__rateLimitBucketCountForTests()).toBeLessThanOrEqual(MAX_BUCKETS);
    expect(__rateLimitBucketCountForTests()).toBe(MAX_BUCKETS);

    // The victim of a flood is only ever an idle actor, and only ever by
    // having a FULL budget restored — never by being granted extra tokens.
    const survivor = `flood:${MAX_BUCKETS + 2_499}`;
    for (let i = 0; i < LIMIT.capacity - 1; i++) {
      expect(consumeToken(survivor, LIMIT, NOW).ok).toBe(true);
    }
    expect(consumeToken(survivor, LIMIT, NOW).ok).toBe(false);
  });

  it("evicts the least-recently-used actor and retains the active one", () => {
    // `idle` is touched ONCE and never again; `active` is re-touched all the
    // way through the flood. The pair is what discriminates: dropping the
    // eviction retains `idle` (4 tokens left, not a fresh 5), and evicting
    // the WRONG end drops `active` instead.
    consumeToken("idle", LIMIT, NOW);
    consumeToken("active", LIMIT, NOW);
    for (let i = 0; i < MAX_BUCKETS + 50; i++) {
      consumeToken(`noise:${i}`, LIMIT, NOW);
      if (i % 100 === 0) consumeToken("active", LIMIT, NOW);
    }

    const stored = new Set(__rateLimitBucketKeysForTests());
    expect(stored.has("idle")).toBe(false);
    expect(stored.has("active")).toBe(true);

    // `idle` was evicted, so it starts a brand-new FULL budget…
    let idleAllowed = 0;
    while (consumeToken("idle", LIMIT, NOW).ok) idleAllowed++;
    expect(idleAllowed).toBe(LIMIT.capacity);

    // …while `active` kept the bucket it exhausted during the flood.
    let activeAllowed = 0;
    while (consumeToken("active", LIMIT, NOW).ok) activeAllowed++;
    expect(activeAllowed).toBe(0);
  });

  it("retires stale buckets a few at a time instead of sweeping the whole map", () => {
    for (let i = 0; i < 50; i++) {
      consumeToken(`old:${i}`, NO_REFILL, NOW);
    }
    const later = NOW + STALE_AFTER_MS + 1;
    // One consume retires at most MAX_EVICTIONS_PER_CONSUME stale entries from
    // the front, so the 50 idle buckets drain over several calls rather than
    // in a single O(n) stall.
    consumeToken("trigger", NO_REFILL, later);

    const stored = new Set(__rateLimitBucketKeysForTests());
    // Retired: exactly the oldest MAX_EVICTIONS_PER_CONSUME entries.
    for (let i = 0; i < MAX_EVICTIONS_PER_CONSUME; i++) {
      expect(stored.has(`old:${i}`)).toBe(false);
    }
    // Retained: everything beyond the bound survives ONE trigger consume.
    // This is the half that fails for an unbounded full sweep.
    for (let i = MAX_EVICTIONS_PER_CONSUME; i < 50; i++) {
      expect(stored.has(`old:${i}`)).toBe(true);
    }
    expect(stored.size).toBe(50 - MAX_EVICTIONS_PER_CONSUME + 1);

    // Budget half: `old:0` was retired, so it starts fresh. With
    // `refillPerSec: 0` a RETAINED `old:0` would only have its remaining 4.
    let allowed = 0;
    while (consumeToken("old:0", NO_REFILL, later).ok) allowed++;
    expect(allowed).toBe(NO_REFILL.capacity);
  });

  it("drains a flooded map over successive consumes, a bounded amount each time", () => {
    for (let i = 0; i < MAX_BUCKETS + 2_500; i++) {
      consumeToken(`flood:${i}`, LIMIT, NOW);
    }
    expect(__rateLimitBucketCountForTests()).toBe(MAX_BUCKETS);

    // Once every entry is stale, each consume retires MAX_EVICTIONS_PER_CONSUME
    // and inserts its own key: a net -(MAX_EVICTIONS_PER_CONSUME - 1) per call.
    // No retirement at all leaves the map pinned at the cap; an unbounded sweep
    // would collapse it to a single entry in one call.
    const later = NOW + STALE_AFTER_MS + 1;
    consumeToken("drain:0", LIMIT, later);
    expect(__rateLimitBucketCountForTests()).toBe(MAX_BUCKETS - MAX_EVICTIONS_PER_CONSUME + 1);
    consumeToken("drain:1", LIMIT, later);
    expect(__rateLimitBucketCountForTests()).toBe(MAX_BUCKETS - 2 * MAX_EVICTIONS_PER_CONSUME + 2);
  });

  it("leaves fresh buckets alone even when the front of the map is fresh", () => {
    consumeToken("fresh", LIMIT, NOW);
    consumeToken("other", LIMIT, NOW);
    // Nothing is stale, so the retirement loop stops on the first entry.
    let allowed = 0;
    while (consumeToken("fresh", LIMIT, NOW).ok) allowed++;
    expect(allowed).toBe(LIMIT.capacity - 1);
    expect(__rateLimitBucketCountForTests()).toBe(2);
  });
});
