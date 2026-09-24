import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type * as InMemoryModule from "@/lib/admin/rate-limit.server";
import type * as TieredModule from "@/lib/admin/rate-limit-tiered.server";

/**
 * `consumeSourceThenGlobal` (F-18): the per-source bucket is consulted FIRST,
 * and the deployment-wide floor is charged only for a request its source
 * bucket admitted.
 *
 * The three pre-auth floors used to take the global token first, so a single
 * IP whose own requests were being refused still spent one deployment-wide
 * token per request and could hold the floor at zero for every tenant.
 *
 * The shared (Postgres) primitive is replaced by the real in-memory token
 * bucket behind a recording spy, so the bucket arithmetic is real and every
 * consume, admitted or refused, is observable in order. The shared
 * primitive's own atomicity and fallback are pinned by rate-limit-shared.test.ts
 * and tests/db/rate-limit-shared.db.test.ts.
 */
const sharedConsume = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin/rate-limit-shared.server", () => ({
  consumeSharedToken: (...a: unknown[]) => sharedConsume(...a),
}));

const SOURCE = { capacity: 2, refillPerSec: 0.5 };
const GLOBAL = { capacity: 5, refillPerSec: 0.1 };
const LIMITS = { source: SOURCE, global: GLOBAL };
const T0 = 1_700_000_000_000;
const GLOBAL_KEY = "scope:__global__";

let inMemory: typeof InMemoryModule;
let consumeSourceThenGlobal: typeof TieredModule.consumeSourceThenGlobal;

/** Every key consumed so far, in call order. */
function keys(): string[] {
  return sharedConsume.mock.calls.map((c) => String(c[0]));
}

function globalConsumes(): number {
  return keys().filter((k) => k === GLOBAL_KEY).length;
}

beforeEach(async () => {
  inMemory = await import("@/lib/admin/rate-limit.server");
  inMemory.__resetRateLimitForTests();
  sharedConsume
    .mockReset()
    .mockImplementation(
      async (key: string, options: InMemoryModule.RateLimitOptions, now?: number) =>
        inMemory.consumeToken(key, options, now),
    );
  ({ consumeSourceThenGlobal } = await import("@/lib/admin/rate-limit-tiered.server"));
});

describe("consumeSourceThenGlobal (F-18)", () => {
  it("admits when both tiers admit, consulting the source bucket before the global floor", async () => {
    expect(await consumeSourceThenGlobal("scope", "ip:a", LIMITS, T0)).toEqual({ ok: true });
    // The key shapes are the ones the shared rows already use, so the fix
    // re-orders the checks without renaming (and resetting) any bucket.
    expect(sharedConsume.mock.calls).toEqual([
      ["scope:ip:a", SOURCE, T0],
      [GLOBAL_KEY, GLOBAL, T0],
    ]);
  });

  it("a request refused per source never touches the global floor", async () => {
    const results: TieredModule.TieredRateLimitResult[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await consumeSourceThenGlobal("scope", "ip:a", LIMITS, T0));
    }
    expect(results.slice(0, 2)).toEqual([{ ok: true }, { ok: true }]);
    // The refusing bucket's own Retry-After: one token at 0.5/s.
    expect(results.slice(2)).toEqual(
      Array(3).fill({ ok: false, retryAfterSeconds: 2, tier: "source" }),
    );
    // Five requests, two admitted per source: two global tokens, not five.
    expect(globalConsumes()).toBe(2);
    expect(keys()).toEqual([
      "scope:ip:a",
      GLOBAL_KEY,
      "scope:ip:a",
      GLOBAL_KEY,
      "scope:ip:a",
      "scope:ip:a",
      "scope:ip:a",
    ]);

    // Behaviourally: the global floor still holds the 3 tokens ip:a's
    // refused requests did not spend, and other sources get exactly those.
    for (const ip of ["ip:b", "ip:c", "ip:d"]) {
      expect(await consumeSourceThenGlobal("scope", ip, LIMITS, T0)).toEqual({ ok: true });
    }
    expect(await consumeSourceThenGlobal("scope", "ip:e", LIMITS, T0)).toEqual({
      ok: false,
      retryAfterSeconds: 10,
      tier: "global",
    });
  });

  it("a global refusal comes only after source admission and spends that source's token (the accepted trade-off)", async () => {
    for (let i = 0; i < GLOBAL.capacity; i++) {
      expect(await consumeSourceThenGlobal("scope", `ip:${i}`, LIMITS, T0)).toEqual({ ok: true });
    }
    sharedConsume.mockClear();

    // The global floor is empty: ip:x is admitted by its own bucket, THEN refused.
    const refused = { ok: false, retryAfterSeconds: 10, tier: "global" };
    expect(await consumeSourceThenGlobal("scope", "ip:x", LIMITS, T0)).toEqual(refused);
    expect(keys()).toEqual(["scope:ip:x", GLOBAL_KEY]);
    // Its second request is admitted by its last source token and refused globally again…
    expect(await consumeSourceThenGlobal("scope", "ip:x", LIMITS, T0)).toEqual(refused);
    // …so its third is refused by its OWN bucket: the global refusals cost it
    // its own budget, and nobody else's.
    expect(await consumeSourceThenGlobal("scope", "ip:x", LIMITS, T0)).toEqual({
      ok: false,
      retryAfterSeconds: 2,
      tier: "source",
    });
    expect(keys().slice(4)).toEqual(["scope:ip:x"]);
  });

  it("uses the scope for both tiers, so floors of different routes never share a bucket", async () => {
    await consumeSourceThenGlobal("api.token", "ip:a", LIMITS, T0);
    await consumeSourceThenGlobal("mcp.register", "ip:a", LIMITS, T0);
    expect(keys()).toEqual([
      "api.token:ip:a",
      "api.token:__global__",
      "mcp.register:ip:a",
      "mcp.register:__global__",
    ]);
  });

  it("property: the global floor is charged exactly once per source-admitted request, never for a source refusal", async () => {
    const step = fc.record({
      source: fc.constantFrom("ip:a", "ip:b", "ip:c", "anon"),
      advanceMs: fc.integer({ min: 0, max: 4_000 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 60 }), async (steps) => {
        inMemory.__resetRateLimitForTests();
        sharedConsume.mockClear();
        let now = T0;
        let sourceAdmitted = 0;
        for (const { source, advanceMs } of steps) {
          now += advanceMs;
          const before = sharedConsume.mock.calls.length;
          const result = await consumeSourceThenGlobal("scope", source, LIMITS, now);
          const consumed = keys().slice(before);
          if (!result.ok && result.tier === "source") {
            // Refused per source: the source bucket alone was consulted.
            expect(consumed).toEqual([`scope:${source}`]);
          } else {
            // Admitted per source: source first, then exactly one global consume.
            expect(consumed).toEqual([`scope:${source}`, GLOBAL_KEY]);
            sourceAdmitted++;
          }
        }
        expect(globalConsumes()).toBe(sourceAdmitted);
      }),
      { numRuns: 200 },
    );
  });
});
