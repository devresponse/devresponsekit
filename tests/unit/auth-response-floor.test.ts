import { describe, expect, it, vi } from "vitest";
import {
  authResponseFloor,
  isResponseFloorCall,
  RESPONSE_FLOOR_JITTER_MS,
  RESPONSE_FLOOR_MS,
  RESPONSE_FLOOR_PATHS,
} from "@/lib/auth-response-floor";

/**
 * F-20: the response-time floor on the three public endpoints that answer the
 * same for every email. The hooks are driven directly here, with short
 * floors; tests/security/auth-email-enumeration-timing.test.ts drives the real
 * `auth` instance through `auth.handler` with the production values.
 */

type Hook = (ctx: unknown) => Promise<unknown>;

function hooksOf(plugin: ReturnType<typeof authResponseFloor>) {
  const before = plugin.hooks.before[0]!;
  const after = plugin.hooks.after[0]!;
  return {
    before: before.handler as unknown as Hook,
    after: after.handler as unknown as Hook,
    beforeMatcher: before.matcher,
    afterMatcher: after.matcher,
  };
}

function httpCall(path: string) {
  return {
    path,
    request: new Request(`http://localhost:3000/api/auth${path}`, { method: "POST" }),
    context: {},
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

describe("which calls get the floor", () => {
  it("covers exactly sign-up, password-reset request and resend-verification", () => {
    expect([...RESPONSE_FLOOR_PATHS]).toEqual([
      "/sign-up/email",
      "/request-password-reset",
      "/send-verification-email",
    ]);
  });

  it("pins the production size: 500 ms plus up to 50 ms of jitter", () => {
    expect(RESPONSE_FLOOR_MS).toBe(500);
    expect(RESPONSE_FLOOR_JITTER_MS).toBe(50);
  });

  it("matches an HTTP call to each floored endpoint", () => {
    for (const path of RESPONSE_FLOOR_PATHS) {
      expect(isResponseFloorCall(httpCall(path)), path).toBe(true);
    }
  });

  it("skips server-side auth.api calls, which carry no request (admin reset email, seeds)", () => {
    for (const path of RESPONSE_FLOOR_PATHS) {
      expect(isResponseFloorCall({ path }), path).toBe(false);
    }
  });

  it("skips every other endpoint, including the other password and sign-in routes", () => {
    for (const path of ["/sign-in/email", "/reset-password", "/reset-password/:token", "/ok"]) {
      expect(isResponseFloorCall(httpCall(path)), path).toBe(false);
    }
    // `ctx.path` is the route pattern; a URL spelling never reaches it.
    expect(isResponseFloorCall(httpCall("/sign-up/email/"))).toBe(false);
    expect(isResponseFloorCall({ request: httpCall("/x").request })).toBe(false);
  });

  it("uses the same matcher before and after, so a start is always paired with its wait", () => {
    const { beforeMatcher, afterMatcher } = hooksOf(authResponseFloor());
    expect(beforeMatcher).toBe(isResponseFloorCall);
    expect(afterMatcher).toBe(isResponseFloorCall);
  });
});

describe("the wait", () => {
  it("holds a fast response until the floor has passed since the before hook", async () => {
    const { before, after } = hooksOf(authResponseFloor({ floorMs: 150, jitterMs: 0 }));
    const call = httpCall("/request-password-reset");

    const elapsed = await timed(async () => {
      await before(call);
      await after(call);
    });

    // Timers can fire a millisecond early on some platforms.
    expect(elapsed).toBeGreaterThanOrEqual(148);
    expect(elapsed).toBeLessThan(400);
  });

  it("adds nothing once the endpoint itself took longer than the floor", async () => {
    const { before, after } = hooksOf(authResponseFloor({ floorMs: 60, jitterMs: 0 }));
    const call = httpCall("/sign-up/email");

    await before(call);
    await sleep(90);
    expect(await timed(() => after(call))).toBeLessThan(40);
  });

  it("draws the jitter from 0 to jitterMs inclusive, once per response", async () => {
    const random = vi.fn((maxExclusive: number) => maxExclusive - 1);
    const { before, after } = hooksOf(authResponseFloor({ floorMs: 10, jitterMs: 60, random }));
    const call = httpCall("/send-verification-email");

    await before(call);
    await after(call);

    expect(random.mock.calls).toEqual([[61]]);
  });

  it("adds the drawn jitter on top of the floor", async () => {
    // The largest draw: the response waits floor + jitterMs.
    const { before, after } = hooksOf(
      authResponseFloor({ floorMs: 40, jitterMs: 60, random: (maxExclusive) => maxExclusive - 1 }),
    );
    const call = httpCall("/send-verification-email");

    const elapsed = await timed(async () => {
      await before(call);
      await after(call);
    });

    // Timers can fire a millisecond early on some platforms.
    expect(elapsed).toBeGreaterThanOrEqual(40 + 60 - 2);
    expect(elapsed).toBeLessThan(40 + 60 + 150);
  });

  it("defaults to crypto.randomInt, and draws nothing when jitter is off", async () => {
    // The default source works and stays inside the bounds.
    const withDefault = hooksOf(authResponseFloor({ floorMs: 20, jitterMs: 30 }));
    const call = httpCall("/sign-up/email");
    const elapsed = await timed(async () => {
      await withDefault.before(call);
      await withDefault.after(call);
    });
    expect(elapsed).toBeGreaterThanOrEqual(18);
    expect(elapsed).toBeLessThan(20 + 30 + 150);

    const random = vi.fn(() => 0);
    const off = hooksOf(authResponseFloor({ floorMs: 10, jitterMs: 0, random }));
    const quiet = httpCall("/sign-up/email");
    await off.before(quiet);
    await off.after(quiet);
    expect(random).not.toHaveBeenCalled();
  });

  it("keys the start on the request, so concurrent calls do not share a clock", async () => {
    const { before, after } = hooksOf(authResponseFloor({ floorMs: 120, jitterMs: 0 }));
    const first = httpCall("/sign-up/email");
    const second = httpCall("/sign-up/email");

    await before(first);
    await sleep(100);
    await before(second);
    // `first` is nearly due; `second` has its whole floor ahead of it.
    expect(await timed(() => after(first))).toBeLessThan(80);
    expect(await timed(() => after(second))).toBeGreaterThanOrEqual(90);
  });

  it("waits only once per request, and not at all without a recorded start", async () => {
    const { before, after } = hooksOf(authResponseFloor({ floorMs: 100, jitterMs: 0 }));
    const call = httpCall("/request-password-reset");

    expect(await timed(() => after(call))).toBeLessThan(40);
    await before(call);
    await after(call);
    expect(await timed(() => after(call))).toBeLessThan(40);
  });
});
