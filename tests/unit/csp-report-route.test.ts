import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RouteModule from "@/app/api/security/csp-report/route";

/**
 * Contract for the CSP violation sink `POST /api/security/csp-report` (A7).
 * It parses both wire formats, logs each violation via the structured logger,
 * and is hardened against a hostile/unauthenticated caller: it ALWAYS answers
 * 204, swallows garbage, caps the body, and truncates fields.
 */
const warnSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/logger.server", () => ({
  logger: { warn: warnSpy, error: vi.fn(), info: vi.fn() },
}));
// The flood floor consumes from the SHARED Postgres bucket (review #98); this
// suite has no database, so the shared primitive is routed through the real
// in-memory bucket — the per-IP exhaustion below still exercises real
// token-bucket arithmetic, only the store differs.
vi.mock("@/lib/admin/rate-limit-shared.server", async () => {
  const { consumeToken } = await import("@/lib/admin/rate-limit.server");
  return {
    consumeSharedToken: async (key: string, options: never, nowMs?: number) =>
      consumeToken(key, options, nowMs),
  };
});

const URL = "https://app.test/api/security/csp-report";

function post(body: string, contentType: string): Request {
  return new Request(URL, { method: "POST", headers: { "content-type": contentType }, body });
}

let POST: typeof RouteModule.POST;

beforeEach(async () => {
  warnSpy.mockReset();
  ({ POST } = await import("@/app/api/security/csp-report/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/security/csp-report", () => {
  it("logs a legacy application/csp-report violation and returns 204", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://app.test/dashboard",
        "effective-directive": "script-src",
        "blocked-uri": "https://evil.example/x.js",
        "line-number": 12,
        disposition: "report",
      },
    });
    const res = await POST(post(body, "application/csp-report"));

    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      kind: "csp-violation",
      effectiveDirective: "script-src",
      blockedUri: "https://evil.example/x.js",
      documentUri: "https://app.test/dashboard",
      lineNumber: 12,
      disposition: "report",
    });
  });

  it("falls back to violated-directive when effective-directive is absent", async () => {
    const body = JSON.stringify({ "csp-report": { "violated-directive": "img-src" } });
    await POST(post(body, "application/csp-report"));
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ effectiveDirective: "img-src" });
  });

  it("logs only csp-violation entries from a Reporting API batch", async () => {
    const body = JSON.stringify([
      { type: "csp-violation", body: { effectiveDirective: "style-src", blockedURL: "inline" } },
      { type: "deprecation", body: { id: "x" } },
      { type: "csp-violation", body: { effectiveDirective: "connect-src" } },
    ]);
    const res = await POST(post(body, "application/reports+json"));

    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      effectiveDirective: "style-src",
      blockedUri: "inline",
    });
    expect(warnSpy.mock.calls[1]?.[0]).toMatchObject({ effectiveDirective: "connect-src" });
  });

  it("truncates an over-long field but still logs", async () => {
    const huge = "a".repeat(3000);
    const body = JSON.stringify({ "csp-report": { "blocked-uri": huge } });
    await POST(post(body, "application/csp-report"));

    const logged = warnSpy.mock.calls[0]?.[0] as { blockedUri: string };
    expect(logged.blockedUri.endsWith("…[truncated]")).toBe(true);
    expect(logged.blockedUri.length).toBe(2048 + "…[truncated]".length);
  });

  it("ignores an oversized body without logging (204)", async () => {
    const body = JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(70 * 1024) } });
    const res = await POST(post(body, "application/csp-report"));
    expect(res.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("swallows invalid JSON without logging (204)", async () => {
    const res = await POST(post("}{ not json", "application/csp-report"));
    expect(res.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores an empty body (204)", async () => {
    const res = await POST(post("", "application/csp-report"));
    expect(res.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores a well-formed body that is not a CSP report (204)", async () => {
    const res = await POST(post(JSON.stringify({ hello: "world" }), "application/json"));
    expect(res.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("aggregates same-directive violations into one line with a count (P2-5)", async () => {
    const body = JSON.stringify([
      { type: "csp-violation", body: { effectiveDirective: "script-src", blockedURL: "a" } },
      { type: "csp-violation", body: { effectiveDirective: "script-src", blockedURL: "b" } },
      { type: "csp-violation", body: { effectiveDirective: "script-src", blockedURL: "c" } },
    ]);
    await POST(post(body, "application/reports+json"));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      effectiveDirective: "script-src",
      count: 3,
    });
  });

  it("caps violations processed per request and flags truncation (P2-5)", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      type: "csp-violation",
      body: { effectiveDirective: `dir-${i}`, blockedURL: "x" },
    }));
    await POST(post(JSON.stringify(entries), "application/reports+json"));
    // At most MAX_VIOLATIONS_PER_REQUEST (20) distinct directives are logged.
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(20);
    expect(warnSpy.mock.calls.some((c) => (c[0] as { truncated?: number }).truncated === 50)).toBe(
      true,
    );
  });

  it("applies a per-IP flood floor — drops reports once the bucket is exhausted (P2-5)", async () => {
    const body = JSON.stringify({ "csp-report": { "effective-directive": "img-src" } });
    for (let i = 0; i < 40; i += 1) {
      const res = await POST(post(body, "application/csp-report"));
      expect(res.status).toBe(204); // always 204, even when throttled
    }
    // The per-IP token bucket caps logged reports well below the 40 sent.
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    expect(warnSpy.mock.calls.length).toBeLessThan(40);
  });
});
