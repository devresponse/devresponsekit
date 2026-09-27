import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { db, pgPool } from "@/db/database";
import { __resetSharedRateLimitForTests } from "@/lib/admin/rate-limit-shared.server";
import {
  SIGN_IN_EMAIL_LIMIT,
  SIGN_IN_EMAIL_RATE_LIMIT_SCOPE,
  signInAttempts,
  signInEmailDigest,
} from "@/lib/auth-sign-in-attempts";

/**
 * F-55 against live Postgres: the per-account sign-in budget is ONE budget
 * across instances, even under a concurrent burst, and `app_rate_limits`
 * stores a keyed digest of the address, never the address.
 *
 * Two `betterAuth` instances stand in for two serverless instances: each has
 * its own (memory) auth store and its own per-IP limiter, and both take the
 * per-account token from the real shared bucket. The unit suite
 * (tests/security/auth-sign-in-attempts.test.ts) pins the rest of the
 * behaviour on the in-process limiter.
 */
vi.mock("@/lib/observability/pre-auth-refusal.server", () => ({ logPreAuthRefusal: vi.fn() }));

const BASE_URL = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret";

function makeAuth() {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    // Allow-listed dummy (see .gitleaks.toml).
    secret: SECRET,
    baseURL: BASE_URL,
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: true, storage: "memory" },
    advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    plugins: [signInAttempts()],
  });
}

let ipSeq = 0;
function signIn(auth: ReturnType<typeof makeAuth>, email: string): Promise<Response> {
  ipSeq += 1;
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE_URL,
        // A new client address per attempt: the per-IP limit never bites.
        "x-forwarded-for": `203.0.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`,
      },
      body: JSON.stringify({ email, password: "a-wrong-guess" }),
    }),
  );
}

const emails: string[] = [];
function freshEmail(): string {
  const email = `dbtest-signin-${randomUUID()}@example.com`;
  emails.push(email);
  return email;
}
const keyOf = (email: string) =>
  `${SIGN_IN_EMAIL_RATE_LIMIT_SCOPE}:${signInEmailDigest(SECRET, email)}`;

async function cleanup(): Promise<void> {
  if (emails.length === 0) return;
  await db.deleteFrom("app_rate_limits").where("key", "in", emails.map(keyOf)).execute();
}

beforeAll(cleanup);
afterEach(() => __resetSharedRateLimitForTests());
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-55: the per-account sign-in budget lives in app_rate_limits", () => {
  it("is one budget across two instances, and stores the digest, not the address", async () => {
    const [a, b] = [makeAuth(), makeAuth()];
    const email = freshEmail();

    for (let i = 0; i < SIGN_IN_EMAIL_LIMIT.capacity; i += 1) {
      const res = await signIn(i % 2 === 0 ? a : b, email);
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    expect((await signIn(a, email)).status).toBe(429);
    expect((await signIn(b, email)).status).toBe(429);

    const rows = await db
      .selectFrom("app_rate_limits")
      .select(["key", "tokens"])
      .where("key", "like", `${SIGN_IN_EMAIL_RATE_LIMIT_SCOPE}:%`)
      .execute();
    const row = rows.find((r) => r.key === keyOf(email));
    expect(row && Number(row.tokens)).toBeLessThan(1);
    expect(rows.some((r) => r.key.toLowerCase().includes("dbtest-signin"))).toBe(false);
  });

  it("admits exactly the budget from a concurrent burst spread over many addresses", async () => {
    const [a, b] = [makeAuth(), makeAuth()];
    const email = freshEmail();

    const statuses = (
      await Promise.all(Array.from({ length: 30 }, (_, i) => signIn(i % 2 === 0 ? a : b, email)))
    ).map((res) => res.status);

    expect(statuses.filter((s) => s === 401)).toHaveLength(SIGN_IN_EMAIL_LIMIT.capacity);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30 - SIGN_IN_EMAIL_LIMIT.capacity);
  });
});
