import { beforeEach, describe, expect, it, vi } from "vitest";

// The rate-limit deny path lazy-imports `auditEvent`; stub it so the counter
// wiring tests never reach `audit.server` → `db`.
const auditSpy = vi.hoisted(() => vi.fn((_input: unknown) => Promise.resolve()));
vi.mock("@/lib/audit.server", () => ({ auditEvent: auditSpy }));

import { GET } from "@/app/api/metrics/route";
import { __resetRateLimitForTests, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { __resetMetricsForTests, registry } from "@/lib/observability/metrics.server";

/**
 * Tests for the Prometheus scrape endpoint and its denial-counter wiring
 * (observability epic #52).
 *
 * Two contracts:
 *   - `GET /api/metrics` is token-guarded and **fails closed**: no token
 *     configured ⇒ 401, wrong/missing bearer ⇒ 401, correct bearer ⇒ 200 with
 *     the Prometheus text exposition.
 *   - Every rate-limit denial increments
 *     `devresponsekit_rate_limit_denials_total{scope}` — the canonical abuse
 *     signal, counted on *all* denials (unlike the flood-gated denial audit).
 *
 * Time is injected via the limiter's `nowMs` arg for determinism.
 */
const TOKEN = "test-metrics-token-0123456789";

function scrapeRequest(authHeader?: string): Request {
  return new Request("http://localhost/api/metrics", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe("GET /api/metrics", () => {
  beforeEach(() => {
    __resetMetricsForTests();
    __resetRateLimitForTests();
    auditSpy.mockClear();
    vi.unstubAllEnvs();
  });

  describe("authorization guard (fails closed)", () => {
    it("returns 401 when METRICS_TOKEN is unset", async () => {
      // No stub — the env carries no token, so the endpoint is disabled.
      const res = await GET(scrapeRequest(`Bearer ${TOKEN}`));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("returns 401 when the Authorization header is missing", async () => {
      vi.stubEnv("METRICS_TOKEN", TOKEN);
      const res = await GET(scrapeRequest());
      expect(res.status).toBe(401);
    });

    it("returns 401 for a non-Bearer Authorization scheme", async () => {
      vi.stubEnv("METRICS_TOKEN", TOKEN);
      const res = await GET(scrapeRequest(`Basic ${TOKEN}`));
      expect(res.status).toBe(401);
    });

    it("returns 401 for a wrong token of equal length (constant-time compare path)", async () => {
      vi.stubEnv("METRICS_TOKEN", TOKEN);
      const res = await GET(scrapeRequest(`Bearer ${"x".repeat(TOKEN.length)}`));
      expect(res.status).toBe(401);
    });
  });

  describe("authorized scrape", () => {
    beforeEach(() => {
      vi.stubEnv("METRICS_TOKEN", TOKEN);
    });

    it("returns 200 with the Prometheus content-type and no-store", async () => {
      const res = await GET(scrapeRequest(`Bearer ${TOKEN}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("exposes Node/process default metrics under the app prefix", async () => {
      const res = await GET(scrapeRequest(`Bearer ${TOKEN}`));
      const body = await res.text();
      // `nodejs_*` defaults are cross-platform (heap, event-loop lag, version).
      expect(body).toContain("devresponsekit_nodejs_");
    });

    it("registers the denials counter (HELP/TYPE emitted even at zero)", async () => {
      const res = await GET(scrapeRequest(`Bearer ${TOKEN}`));
      const body = await res.text();
      expect(body).toContain("# TYPE devresponsekit_rate_limit_denials_total counter");
    });
  });

  describe("rate-limit denial counter wiring", () => {
    it("counts every 429 for a scope", async () => {
      const opts = { capacity: 1, refillPerSec: 1 };
      // First call consumes the only token (allowed → no increment).
      expect(enforceRateLimit("metrics.test", "ba-1", opts, undefined, undefined, 0)).toBeNull();
      // Two denials at the same instant → counter == 2.
      expect(
        enforceRateLimit("metrics.test", "ba-1", opts, undefined, undefined, 0),
      ).not.toBeNull();
      expect(
        enforceRateLimit("metrics.test", "ba-1", opts, undefined, undefined, 0),
      ).not.toBeNull();

      const body = await registry.metrics();
      expect(body).toContain('devresponsekit_rate_limit_denials_total{scope="metrics.test"} 2');
    });

    it("labels denials by scope independently", async () => {
      const opts = { capacity: 1, refillPerSec: 1 };
      enforceRateLimit("scope.a", "ba-1", opts, undefined, undefined, 0); // allow
      enforceRateLimit("scope.a", "ba-1", opts, undefined, undefined, 0); // deny (a: 1)
      enforceRateLimit("scope.b", "ba-1", opts, undefined, undefined, 0); // allow
      enforceRateLimit("scope.b", "ba-1", opts, undefined, undefined, 0); // deny (b: 1)
      enforceRateLimit("scope.b", "ba-1", opts, undefined, undefined, 0); // deny (b: 2)

      const body = await registry.metrics();
      expect(body).toContain('devresponsekit_rate_limit_denials_total{scope="scope.a"} 1');
      expect(body).toContain('devresponsekit_rate_limit_denials_total{scope="scope.b"} 2');
    });
  });
});
