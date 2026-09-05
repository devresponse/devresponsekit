import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";

/**
 * POST /api/v1/auth/token — limiter KEYING (review #11).
 *
 * The pre-auth bucket used to be keyed on the unauthenticated, attacker-
 * supplied `client_id`, so anyone who knew a victim's public id could drain
 * the victim's budget from any network, an attacker could escape the per-IP
 * bucket by rotating ids, and attacker-chosen strings became limiter keys.
 *
 * Contract pinned here:
 *   - pre-auth buckets are keyed on the trusted client IP + a global floor;
 *   - a per-credential bucket exists ONLY after the credential verified;
 *   - unknown / random ids never allocate a bucket;
 *   - legitimate bursts still 429 with problem+json + `Retry-After`;
 *   - the deployment-wide floor still applies across IPs.
 *
 * The REAL token-bucket limiter runs (wrapped in a recording spy so the
 * exact keys can be asserted); credential verification, persistence and
 * minting are mocked.
 */
const env = vi.hoisted(() => ({
  API_JWT_ENABLED: true,
  API_KEYS_ENABLED: true,
  API_JWT_PRIVATE_KEY: "{}",
  BETTER_AUTH_URL: "https://app.example.com",
  API_JWT_AUDIENCE: "devresponse-api",
  API_JWT_ACCESS_TTL_SECONDS: 900,
}));
const consumeToken = vi.hoisted(() => vi.fn());
const auditEvent = vi.fn();
const verifyClientCredentials = vi.fn();
const verifyApiKey = vi.fn();
const isBetterAuthUserBanned = vi.fn();
const mintAccessToken = vi.fn();
const getUserAccessContext = vi.fn();

// `intFromEnv` backs TRUSTED_PROXY_COUNT in client-ip.ts; the default (1) is
// the topology under test (one trusted proxy → rightmost XFF entry).
vi.mock("@/lib/env", () => ({
  getServerEnv: () => env,
  intFromEnv: (_name: string, fallback: number) => fallback,
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => getUserAccessContext(id) };
});
vi.mock("@/lib/admin/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
  consumeToken.mockImplementation(actual.consumeToken);
  return { ...actual, consumeToken: (...a: unknown[]) => consumeToken(...a) };
});
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  verifyClientCredentials: (...a: unknown[]) => verifyClientCredentials(...a),
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  verifyApiKey: (...a: unknown[]) => verifyApiKey(...a),
}));
vi.mock("@/lib/api-auth/ban-status.server", () => ({
  isBetterAuthUserBanned: (...a: unknown[]) => isBetterAuthUserBanned(...a),
}));
vi.mock("@/lib/api-auth/jwt.server", () => ({
  mintAccessToken: (...a: unknown[]) => mintAccessToken(...a),
}));
vi.mock("@/db/database", () => ({ db: {} }));

const VICTIM_ID = "drkc_victim000000000000000";
const VICTIM_SECRET = "drkcsec_correct";
const IP_A = "203.0.113.10";
const IP_B = "198.51.100.20";

function req(ip: string, body: Record<string, string>): NextRequest {
  const url = new URL("http://test.local/api/v1/auth/token");
  return {
    nextUrl: url,
    url: url.toString(),
    method: "POST",
    // Default TRUSTED_PROXY_COUNT=1 → the rightmost XFF entry is the trusted hop.
    headers: new Headers({ "content-type": "application/json", "x-forwarded-for": ip }),
    json: async () => body,
    text: async () => "",
  } as unknown as NextRequest;
}

function mint(ip: string, clientId = VICTIM_ID, secret = VICTIM_SECRET): Promise<Response> {
  return POST(
    req(ip, { grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
  );
}

/** Every limiter key the route consumed from, in call order. */
function consumedKeys(): string[] {
  return consumeToken.mock.calls.map((c) => String(c[0]));
}

let POST: (request: NextRequest) => Promise<Response>;

beforeEach(async () => {
  for (const m of [
    auditEvent,
    verifyClientCredentials,
    verifyApiKey,
    isBetterAuthUserBanned,
    mintAccessToken,
    getUserAccessContext,
  ])
    m.mockReset();
  const rl = await import("@/lib/admin/rate-limit.server");
  rl.__resetRateLimitForTests();
  consumeToken.mockClear();
  const metrics = await import("@/lib/observability/metrics.server");
  metrics.__resetMetricsForTests();

  // Only the victim's real secret verifies; everything else is a wrong guess.
  verifyClientCredentials.mockImplementation(async (id: string, secret: string) =>
    id === VICTIM_ID && secret === VICTIM_SECRET
      ? { betterAuthUserId: "ba-victim", scopes: ["account.read"], organizationId: "o1" }
      : null,
  );
  verifyApiKey.mockResolvedValue(null);
  isBetterAuthUserBanned.mockResolvedValue(false);
  getUserAccessContext.mockResolvedValue({
    status: "active",
    membershipStatus: "active",
    appUserId: "u-victim",
    permissions: [],
  });
  mintAccessToken.mockResolvedValue({
    token: "eyJ.signed",
    expiresInSeconds: 900,
    scopes: ["account.read"],
  });
  POST = (await import("@/app/api/v1/auth/token/route")).POST;
});
afterEach(() => vi.resetModules());

describe("POST /api/v1/auth/token limiter keying (review #11)", () => {
  it("(a) wrong-secret spam on a victim's client_id from IP A never 429s the victim on IP B", async () => {
    // Attacker: 30 wrong-secret attempts against the victim's PUBLIC id. The
    // first 10 burn IP A's burst (401), the rest are throttled — on IP A.
    const attackerStatuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      attackerStatuses.push((await mint(IP_A, VICTIM_ID, "wrong")).status);
    }
    expect(attackerStatuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(attackerStatuses.slice(10)).toEqual(Array(20).fill(429));

    // The attacker's requests never touched a credential-scoped bucket.
    expect(consumedKeys().some((k) => k.startsWith("api.token.credential:"))).toBe(false);
    expect(consumedKeys().some((k) => k.includes(VICTIM_ID))).toBe(false);

    // Victim, from its own network: a full 10-token burst still mints.
    for (let i = 0; i < 10; i++) {
      const res = await mint(IP_B);
      expect(res.status).toBe(200);
    }
    expect(mintAccessToken).toHaveBeenCalledTimes(10);
  });

  it("(b) unknown / rotating client_ids never allocate a bucket and cannot escape the IP bucket", async () => {
    const statuses: number[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = `drkc_random${i}_${crypto.randomUUID()}`;
      ids.push(id);
      statuses.push((await mint(IP_A, id, "guess")).status);
    }
    // Rotating ids buys nothing: the per-IP bucket (capacity 10) still trips.
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual(Array(5).fill(429));

    // No limiter key ever contained an attacker-chosen id; the only keys
    // are the global floor and the trusted-IP bucket.
    const keys = consumedKeys();
    for (const id of ids) expect(keys.some((k) => k.includes(id))).toBe(false);
    expect(new Set(keys)).toEqual(new Set(["api.token:__global__", `api.token:ip:${IP_A}`]));
  });

  it("(c) a legitimate burst beyond the per-IP budget still 429s with problem+json + Retry-After", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) last = await mint(IP_A);
    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(last?.headers.get("Cache-Control")).toBe("no-store");
    const body = (await last!.json()) as { code: string; retryAfter: number };
    expect(body.code).toBe("rate_limited");
    expect(body.retryAfter).toBeGreaterThanOrEqual(1);
    // The 11th request was refused before any verification work.
    expect(verifyClientCredentials).toHaveBeenCalledTimes(10);
    expect(mintAccessToken).toHaveBeenCalledTimes(10);

    // The denial is visible to operators on the metrics scrape.
    const { rateLimitDenialsTotal } = await import("@/lib/observability/metrics.server");
    const denials = (await rateLimitDenialsTotal.get()).values.find(
      (v) => v.labels.scope === "api.token",
    );
    expect(denials?.value).toBe(1);
  });

  it("(c') a VERIFIED credential gets its own bucket, shared across the networks it mints from", async () => {
    // 10 mints from IP A: both the IP-A bucket and the victim's credential
    // bucket are drained.
    for (let i = 0; i < 10; i++) expect((await mint(IP_A)).status).toBe(200);
    expect(consumedKeys()).toContain(`api.token.credential:${VICTIM_ID}`);

    // The 11th mint from a fresh IP passes the IP bucket but trips the
    // credential bucket — fair-share per credential, keyed only post-verify.
    const res = await mint(IP_B);
    expect(res.status).toBe(429);
    expect(verifyClientCredentials).toHaveBeenCalledTimes(11);
    expect(mintAccessToken).toHaveBeenCalledTimes(10);
  });

  it("(b') api_key grant: a verified key's bucket is keyed on the key id, an unverified one allocates none", async () => {
    verifyApiKey.mockImplementation(async (key: string) =>
      key === "drk_live_good"
        ? {
            id: "key-1",
            betterAuthUserId: "ba-victim",
            scopes: ["account.read"],
            organizationId: "o1",
          }
        : null,
    );
    const bad = req(IP_A, { grant_type: "api_key", api_key: "drk_live_bad" });
    expect((await POST(bad)).status).toBe(401);
    expect(consumedKeys().some((k) => k.startsWith("api.token.credential:"))).toBe(false);

    const good = req(IP_A, { grant_type: "api_key", api_key: "drk_live_good" });
    expect((await POST(good)).status).toBe(200);
    expect(consumedKeys()).toContain("api.token.credential:key-1");
    // The plaintext key never becomes a limiter key.
    expect(consumedKeys().some((k) => k.includes("drk_live_good"))).toBe(false);
  });

  it("(d) the deployment-wide global floor still applies across distinct IPs", async () => {
    // 300 requests, each from a fresh IP, exhaust the global burst; the
    // 301st is refused even though its own IP bucket is untouched.
    let last: Response | undefined;
    for (let i = 0; i < 301; i++) {
      last = await mint(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, "drkc_other", "x");
    }
    expect(last?.status).toBe(429);
    // The floor tripped BEFORE the per-IP check: the 301st IP has no bucket.
    expect(consumedKeys()).not.toContain("api.token:ip:10.0.1.44");
    expect(consumedKeys().filter((k) => k === "api.token:__global__")).toHaveLength(301);
  });
});
