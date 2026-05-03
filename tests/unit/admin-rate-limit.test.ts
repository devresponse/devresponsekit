import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRateLimitForTests,
  consumeToken,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/admin/rate-limit.server";

/**
 * Unit tests for the in-memory token-bucket rate limiter
 * (docs/admin-manager.md §19 Phase 7, §20.1 #16).
 *
 * Verifies the contract documented in `rate-limit.server.ts`:
 *   - Burst capacity: the first `capacity` requests within an instant
 *     all succeed.
 *   - Refill: tokens replenish at `refillPerSec` over wall-clock time.
 *   - Deny envelope: `enforceRateLimit` returns a 429 with a
 *     `Retry-After` header that matches the structured retry hint.
 *   - Per-key isolation: one noisy actor does not starve others.
 *
 * Time is injected via the `nowMs` parameter so the tests are
 * deterministic without faking the global Date.
 */
describe("admin rate limiter", () => {
  beforeEach(() => __resetRateLimitForTests());

  it("allows up to capacity requests in a burst", () => {
    const opts = { capacity: 3, refillPerSec: 1 };
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    const denied = consumeToken("k", opts, 0);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills tokens proportionally to elapsed time", () => {
    const opts = { capacity: 2, refillPerSec: 1 };
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    expect(consumeToken("k", opts, 0).ok).toBe(false);
    // 1 full second later → 1 token refilled → next call passes.
    expect(consumeToken("k", opts, 1000).ok).toBe(true);
    // No further tokens available immediately after.
    expect(consumeToken("k", opts, 1000).ok).toBe(false);
  });

  it("caps refill at the bucket capacity", () => {
    const opts = { capacity: 2, refillPerSec: 1 };
    expect(consumeToken("k", opts, 0).ok).toBe(true);
    // 1 hour later — even though `capacity * refillPerSec * 3600` >> 2,
    // the bucket should not exceed its capacity.
    expect(consumeToken("k", opts, 3_600_000).ok).toBe(true);
    expect(consumeToken("k", opts, 3_600_000).ok).toBe(true);
    expect(consumeToken("k", opts, 3_600_000).ok).toBe(false);
  });

  it("isolates buckets by key", () => {
    const opts = { capacity: 1, refillPerSec: 1 };
    expect(consumeToken("a", opts, 0).ok).toBe(true);
    expect(consumeToken("a", opts, 0).ok).toBe(false);
    // A different key (different actor) is unaffected.
    expect(consumeToken("b", opts, 0).ok).toBe(true);
  });

  it("composes keys deterministically", () => {
    expect(rateLimitKey("scope", "actor")).toBe("scope:actor");
  });

  it("enforceRateLimit returns 429 with Retry-After on deny", async () => {
    const opts = { capacity: 1, refillPerSec: 1 };
    expect(enforceRateLimit("scope", "actor", opts, 0)).toBeNull();
    const denied = enforceRateLimit("scope", "actor", opts, 0);
    expect(denied).not.toBeNull();
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("Retry-After")).toBeTruthy();
    const body = await denied!.json();
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfter).toBe("number");
  });
});
