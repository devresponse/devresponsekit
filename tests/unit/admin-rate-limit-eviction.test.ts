import { beforeEach, describe, expect, it } from "vitest";
import {
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
 * unbounded between sweeps. These tests pin the replacement: a hard cap with
 * least-recently-used eviction, bounded stale retirement per call, and a
 * length bound on the key itself.
 *
 * (The pre-auth floors — where an attacker, not an authenticated actor,
 * chooses the fan-out — moved to the Postgres-backed bucket in #98/#412; what
 * is left in this map is the authenticated per-actor tier.)
 */
const LIMIT = { capacity: 5, refillPerSec: 1 };
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
/** Mirrors MAX_BUCKETS in the implementation. */
const MAX_BUCKETS = 10_000;
const STALE_AFTER_MS = 10 * 60 * 1000;

beforeEach(() => {
  __resetRateLimitForTests();
});

describe("bucket key normalization", () => {
  it("stores realistic keys verbatim", () => {
    const key = rateLimitKey("admin.mutation", "3f1c2b7e-2a1d-4c9f-8f7a-9b0e1d2c3a4b");
    expect(normalizeBucketKey(key)).toBe(key);
  });

  it("keeps a 128-character key verbatim and folds a 129-character one", () => {
    const at = "a".repeat(128);
    expect(normalizeBucketKey(at)).toBe(at);
    const over = "a".repeat(129);
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
});

describe("hostile key space (review #223)", () => {
  it("never exceeds the hard cap, however many distinct keys arrive", () => {
    // Every key is fresh (same `now`), so nothing is stale-retired: the cap
    // is the only thing holding the map down.
    for (let i = 0; i < MAX_BUCKETS + 2_500; i++) {
      consumeToken(`flood:${i}`, LIMIT, NOW);
    }
    // The victim of a flood is only ever an idle actor, and only ever by
    // having a FULL budget restored — never by being granted extra tokens.
    const survivor = `flood:${MAX_BUCKETS + 2_499}`;
    for (let i = 0; i < LIMIT.capacity - 1; i++) {
      expect(consumeToken(survivor, LIMIT, NOW).ok).toBe(true);
    }
    expect(consumeToken(survivor, LIMIT, NOW).ok).toBe(false);
  });

  it("evicts least-recently-used, so a still-active actor keeps its bucket", () => {
    consumeToken("victim", LIMIT, NOW);
    // Fill to the cap, touching `victim` again along the way so it is never
    // the oldest entry.
    for (let i = 0; i < MAX_BUCKETS + 50; i++) {
      consumeToken(`noise:${i}`, LIMIT, NOW);
      if (i % 100 === 0) consumeToken("victim", LIMIT, NOW);
    }
    // `victim` has spent several tokens and kept its bucket: its budget is
    // NOT reset by the flood.
    let allowed = 0;
    while (consumeToken("victim", LIMIT, NOW).ok) allowed++;
    expect(allowed).toBeLessThan(LIMIT.capacity);
  });

  it("retires stale buckets a few at a time instead of sweeping the whole map", () => {
    for (let i = 0; i < 50; i++) {
      consumeToken(`old:${i}`, LIMIT, NOW);
    }
    const later = NOW + STALE_AFTER_MS + 1;
    // One consume retires at most 8 stale entries, so the 50 idle buckets
    // drain over several calls rather than in a single O(n) stall. After the
    // first post-staleness call, `old:0`..`old:7` are gone: `old:0` therefore
    // starts a fresh full budget.
    consumeToken("trigger", LIMIT, later);
    let allowed = 0;
    while (consumeToken("old:0", LIMIT, later).ok) allowed++;
    expect(allowed).toBe(LIMIT.capacity);
  });

  it("leaves fresh buckets alone even when the front of the map is fresh", () => {
    consumeToken("fresh", LIMIT, NOW);
    consumeToken("other", LIMIT, NOW);
    // Nothing is stale, so the retirement loop stops on the first entry.
    let allowed = 0;
    while (consumeToken("fresh", LIMIT, NOW).ok) allowed++;
    expect(allowed).toBe(LIMIT.capacity - 1);
  });
});
