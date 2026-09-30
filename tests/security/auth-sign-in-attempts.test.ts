import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  SIGN_IN_EMAIL_LIMIT,
  SIGN_IN_EMAIL_RATE_LIMIT_SCOPE,
  SIGN_IN_FAILED_EVENT_TYPE,
  signInAttempts,
  signInEmailDigest,
} from "@/lib/auth-sign-in-attempts";
import { __resetRateLimitForTests } from "@/lib/http/rate-limit.server";
import type * as InMemoryLimiter from "@/lib/http/rate-limit.server";
import { __resetMetricsForTests, rateLimitDenialsTotal } from "@/lib/observability/metrics.server";

/**
 * F-55 — FAILED SIGN-INS LEAVE A TRACE, AND ONE ACCOUNT'S GUESSES HAVE A BUDGET
 * HOWEVER MANY ADDRESSES THEY COME FROM.
 *
 * A failed `/sign-in/email` was recorded nowhere the app reads, and the only
 * throttle was Better Auth's per-IP limit (3 per 10 s): 1,000 addresses got
 * about 300 guesses a second at one account, unseen until one worked. The
 * `signInAttempts()` plugin adds a per-account bucket (in the shared limiter)
 * and logs each failure as a `pre_auth_refusal` line with a keyed digest of
 * the address, never an audit row.
 *
 * BEHAVIORAL: a real `betterAuth` instance on the memory adapter, with Better
 * Auth's own per-IP limiter ON, driven through `auth.handler`. Every attempt
 * comes from a different client address, so the per-IP limit alone would let
 * all of them through. The shared bucket runs on the in-process limiter with a
 * test clock (its Postgres atomicity is pinned in
 * tests/db/rate-limit-shared.db.test.ts).
 */

const clock = vi.hoisted(() => ({ now: Date.UTC(2026, 8, 26, 12, 0, 0) }));
const sharedMock = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/http/rate-limit-shared.server", async () => {
  const memory = await vi.importActual<typeof InMemoryLimiter>("@/lib/http/rate-limit.server");
  return {
    consumeSharedToken: vi.fn(async (key: string, options: InMemoryLimiter.RateLimitOptions) => {
      if (sharedMock.fail) throw new RangeError("limiter fault");
      return memory.consumeToken(key, options, clock.now);
    }),
  };
});
const logPreAuthRefusal = vi.fn();
vi.mock("@/lib/observability/pre-auth-refusal.server", () => ({
  logPreAuthRefusal: (...args: unknown[]) => logPreAuthRefusal(...args),
}));
const logServerError = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}));

const BASE_URL = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret";
const PASSWORD = "ci-only-sign-in-attempts-password";
const VICTIM = "victim@example.com";

function makeAuth(opts: { plugin?: boolean; limiter?: boolean } = {}) {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    // Allow-listed dummy (see .gitleaks.toml).
    secret: SECRET,
    baseURL: BASE_URL,
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: { sendVerificationEmail: async () => {} },
    // Better Auth's own per-IP limit, as in production (3 per 10 s on sign-in).
    rateLimit: { enabled: opts.limiter ?? true, storage: "memory" },
    advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    plugins: opts.plugin === false ? [] : [signInAttempts()],
  });
}

type TestAuth = ReturnType<typeof makeAuth>;

let ipSeq = 0;
/** A client address no earlier request used, so the per-IP bucket is always full. */
function freshIp(): string {
  ipSeq += 1;
  return `198.51.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

function signIn(auth: TestAuth, body: unknown, ip = freshIp()): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

async function seedUser(auth: TestAuth, email: string, verified = true): Promise<string> {
  const ctx = await auth.$context;
  const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  if (verified) await ctx.internalAdapter.updateUser(res.user.id, { emailVerified: true });
  return res.user.id;
}

/** Spends an address's whole budget on wrong passwords, each from a new address. */
async function exhaust(auth: TestAuth, email: string): Promise<void> {
  for (let i = 0; i < SIGN_IN_EMAIL_LIMIT.capacity; i += 1) {
    const res = await signIn(auth, { email, password: `wrong-${i}` });
    expect(res.status, `attempt ${i + 1}`).toBe(401);
  }
}

async function deniedCount(): Promise<number> {
  const metric = await rateLimitDenialsTotal.get();
  return metric.values.find((v) => v.labels.scope === SIGN_IN_EMAIL_RATE_LIMIT_SCOPE)?.value ?? 0;
}

beforeEach(() => {
  __resetRateLimitForTests();
  __resetMetricsForTests();
  logPreAuthRefusal.mockReset();
  logServerError.mockReset();
  sharedMock.fail = false;
  clock.now += 24 * 60 * 60 * 1000;
});

describe("F-55: a per-account sign-in budget alongside the per-IP limit", () => {
  it("refuses the 11th attempt on one address from 11 addresses — the right password included", async () => {
    const auth = makeAuth();
    const victimId = await seedUser(auth, VICTIM);
    const ctx = await auth.$context;
    const sessionsBefore = (await ctx.internalAdapter.listSessions(victimId)).length;

    await exhaust(auth, VICTIM);
    const res = await signIn(auth, { email: VICTIM, password: PASSWORD });

    expect(res.status).toBe(429);
    expect(res.headers.get("x-retry-after")).toBe("90");
    // The password was never checked: no session was opened.
    expect((await ctx.internalAdapter.listSessions(victimId)).length).toBe(sessionsBefore);
    expect(await deniedCount()).toBe(1);
  });

  it("answers exactly like Better Auth's own per-IP 429, so the two cannot be told apart", async () => {
    const auth = makeAuth();
    await exhaust(auth, VICTIM);
    const perAccount = await signIn(auth, { email: VICTIM, password: "x" });

    // Four attempts from ONE address, each on a different account: the 4th is
    // Better Auth's own per-IP refusal (3 per 10 s).
    const ip = freshIp();
    let perIp: Response | undefined;
    for (let i = 0; i < 4; i += 1) {
      perIp = await signIn(auth, { email: `ip${i}@x.test`, password: "x" }, ip);
    }

    expect(perIp!.status).toBe(429);
    expect(perAccount.status).toBe(429);
    expect(await perAccount.json()).toEqual(await perIp!.json());
  });

  it("CONTROL: without the plugin the same run gets through on the right password", async () => {
    const auth = makeAuth({ plugin: false });
    await seedUser(auth, VICTIM);
    await exhaust(auth, VICTIM);
    expect((await signIn(auth, { email: VICTIM, password: PASSWORD })).status).toBe(200);
  });

  it("shares one bucket across spellings of an address, and never between addresses", async () => {
    const auth = makeAuth();
    await seedUser(auth, "other@example.com");
    await exhaust(auth, VICTIM);

    expect((await signIn(auth, { email: "Victim@Example.COM", password: "x" })).status).toBe(429);
    expect((await signIn(auth, { email: "other@example.com", password: PASSWORD })).status).toBe(
      200,
    );
  });

  it("throttles an address with no account exactly the same way (reveals no account)", async () => {
    const auth = makeAuth();
    await exhaust(auth, "nobody@example.com");
    expect((await signIn(auth, { email: "nobody@example.com", password: "x" })).status).toBe(429);
  });

  it("is a throttle, not a lock: a token returns after 90 s and the full budget within 15 min", async () => {
    const auth = makeAuth();
    await seedUser(auth, VICTIM);
    await exhaust(auth, VICTIM);
    expect((await signIn(auth, { email: VICTIM, password: PASSWORD })).status).toBe(429);

    clock.now += 90 * 1000;
    expect((await signIn(auth, { email: VICTIM, password: PASSWORD })).status).toBe(200);

    clock.now += 15 * 60 * 1000;
    await exhaust(auth, VICTIM);
  });

  it("follows Better Auth's limiter switch (off under AUTH_RATE_LIMIT_DISABLED)", async () => {
    const auth = makeAuth({ limiter: false });
    await seedUser(auth, VICTIM);
    for (let i = 0; i < SIGN_IN_EMAIL_LIMIT.capacity + 5; i += 1) {
      expect((await signIn(auth, { email: VICTIM, password: "wrong" })).status).toBe(401);
    }
    expect((await signIn(auth, { email: VICTIM, password: PASSWORD })).status).toBe(200);
  });

  it("lets the attempt through (per-IP limit only) when the limiter itself fails", async () => {
    const auth = makeAuth();
    await seedUser(auth, VICTIM);
    sharedMock.fail = true;

    expect((await signIn(auth, { email: VICTIM, password: PASSWORD })).status).toBe(200);
    expect(logServerError).toHaveBeenCalledWith(
      "per-account sign-in limit could not be checked; attempt allowed",
      expect.objectContaining({ err: expect.any(RangeError) }),
    );
  });

  it("takes nothing from the budget for a server-side auth.api call", async () => {
    const auth = makeAuth();
    await seedUser(auth, VICTIM);
    for (let i = 0; i < SIGN_IN_EMAIL_LIMIT.capacity + 2; i += 1) {
      await expect(
        auth.api.signInEmail({ body: { email: VICTIM, password: "wrong" } }),
      ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    }
    expect((await signIn(auth, { email: VICTIM, password: PASSWORD })).status).toBe(200);
    expect(logPreAuthRefusal).not.toHaveBeenCalled();
  });
});

describe("F-55: every failed attempt is logged with a keyed digest, never the address", () => {
  const digest = signInEmailDigest(SECRET, VICTIM);

  function loggedCalls() {
    return logPreAuthRefusal.mock.calls.map(([input]) => input as Record<string, unknown>);
  }

  it("logs a wrong password as one pre_auth_refusal carrying the digest", async () => {
    const auth = makeAuth();
    await seedUser(auth, VICTIM);

    await signIn(auth, { email: VICTIM, password: "wrong" });

    expect(loggedCalls()).toEqual([
      expect.objectContaining({
        eventType: SIGN_IN_FAILED_EVENT_TYPE,
        outcome: "denied",
        reason: "INVALID_EMAIL_OR_PASSWORD",
        metadata: { emailHash: digest },
        request: expect.objectContaining({
          method: "POST",
          nextUrl: { pathname: "/api/auth/sign-in/email" },
        }),
      }),
    ]);
    // The address itself is in no argument, in any spelling.
    expect(JSON.stringify(logPreAuthRefusal.mock.calls).toLowerCase()).not.toContain("victim");
  });

  it("logs an unknown address, an unverified one and a malformed body, each with its code", async () => {
    const auth = makeAuth();
    await seedUser(auth, "unverified@example.com", false);

    await signIn(auth, { email: "nobody@example.com", password: "x" });
    await signIn(auth, { email: "unverified@example.com", password: PASSWORD });
    await signIn(auth, { password: "x" });

    expect(
      loggedCalls().map((c) => [c.reason, (c.metadata as { emailHash: unknown }).emailHash]),
    ).toEqual([
      ["INVALID_EMAIL_OR_PASSWORD", signInEmailDigest(SECRET, "nobody@example.com")],
      ["EMAIL_NOT_VERIFIED", signInEmailDigest(SECRET, "unverified@example.com")],
      ["VALIDATION_ERROR", null],
    ]);
  });

  it("logs a throttled attempt with reason rate_limited, and a success not at all", async () => {
    const auth = makeAuth();
    await seedUser(auth, VICTIM);
    expect((await signIn(auth, { email: VICTIM, password: PASSWORD })).status).toBe(200);
    expect(logPreAuthRefusal).not.toHaveBeenCalled();

    // Every attempt costs a token, the success above included.
    for (let i = 1; i < SIGN_IN_EMAIL_LIMIT.capacity; i += 1) {
      expect((await signIn(auth, { email: VICTIM, password: "wrong" })).status).toBe(401);
    }
    logPreAuthRefusal.mockReset();
    expect((await signIn(auth, { email: VICTIM, password: PASSWORD })).status).toBe(429);

    expect(loggedCalls()).toEqual([
      expect.objectContaining({ reason: "rate_limited", metadata: { emailHash: digest } }),
    ]);
  });

  it("keys the digest with the secret, over the lower-cased address", () => {
    expect(signInEmailDigest(SECRET, "Victim@Example.com")).toBe(digest);
    expect(signInEmailDigest("another-secret-another-secret-00", VICTIM)).not.toBe(digest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("wiring: src/lib/auth.ts installs the plugin", () => {
  it("lists signInAttempts() among the plugins, before nextCookies()", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/lib/auth.ts"), "utf8");
    expect(source).toMatch(/signInAttempts\(\),[\s\S]*nextCookies\(\),\s*\]/);
  });
});
