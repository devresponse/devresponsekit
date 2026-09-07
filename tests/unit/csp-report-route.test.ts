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

  // review #77: the URL fields a browser reports name the page the user was
  // on — which for this app can be a one-time-token page. Logging them
  // verbatim copied a live reset / invite / verification token into the log
  // stream (and any aggregator).
  describe("token redaction in reported URLs (review #77)", () => {
    it("strips the query string carrying a reset token from document-uri", async () => {
      const body = JSON.stringify({
        "csp-report": {
          "document-uri": "https://app.test/en/reset-password?token=s3cret-reset-token",
          "effective-directive": "script-src",
        },
      });
      await POST(post(body, "application/csp-report"));
      const line = warnSpy.mock.calls[0]?.[0] as { documentUri?: string };
      expect(line.documentUri).toBe("https://app.test/en/reset-password");
      expect(line.documentUri).not.toContain("s3cret-reset-token");
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain("s3cret-reset-token");
    });

    it("redacts a reset token carried as a PATH segment", async () => {
      const body = JSON.stringify({
        "csp-report": {
          "document-uri": "https://app.test/reset-password/p4th-token-value",
          "effective-directive": "style-src",
        },
      });
      await POST(post(body, "application/csp-report"));
      const line = warnSpy.mock.calls[0]?.[0] as { documentUri?: string };
      expect(line.documentUri).toBe("https://app.test/reset-password/[redacted-token]");
    });

    it("strips a fragment and redacts blocked-uri / source-file too", async () => {
      const body = JSON.stringify({
        "csp-report": {
          "document-uri": "https://app.test/en/invite?token=invite-tok#frag",
          "effective-directive": "img-src",
          "blocked-uri": "https://cdn.test/x.png?token=blocked-tok",
          "source-file": "https://app.test/en/verify-email?token=source-tok#h",
        },
      });
      await POST(post(body, "application/csp-report"));
      const line = warnSpy.mock.calls[0]?.[0] as {
        documentUri?: string;
        blockedUri?: string;
        sourceFile?: string;
      };
      expect(line.documentUri).toBe("https://app.test/en/invite");
      expect(line.blockedUri).toBe("https://cdn.test/x.png");
      expect(line.sourceFile).toBe("https://app.test/en/verify-email");
      const logged = JSON.stringify(warnSpy.mock.calls[0]);
      for (const secret of ["invite-tok", "blocked-tok", "source-tok", "frag"]) {
        expect(logged).not.toContain(secret);
      }
    });

    // The cases above put the secret in a query, a fragment, or a
    // `/reset-password/<tok>` segment — all of which `stripQuery` alone
    // removes, so none of them exercises the `redactText` half of
    // `urlField` (`stripQuery(redactText(value))`). These do: the secret
    // sits in an ORDINARY path segment, which survives a query strip and is
    // only removed by the pattern redactor.
    it("redacts an API key sitting in a blocked-uri PATH segment", async () => {
      const body = JSON.stringify({
        "csp-report": {
          "document-uri": "https://app.test/en/dashboard",
          "effective-directive": "img-src",
          "blocked-uri": "https://cdn.test/drk_live_AbC123xyz/x.png",
        },
      });
      await POST(post(body, "application/csp-report"));
      const line = warnSpy.mock.calls[0]?.[0] as { blockedUri?: string };
      expect(line.blockedUri).toBe("https://cdn.test/[redacted-token]/x.png");
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain("drk_live_AbC123xyz");
    });

    it("redacts a JWT sitting in a source-file PATH segment", async () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.s1gn4tur3-v4lu3";
      const body = JSON.stringify([
        {
          type: "csp-violation",
          body: {
            documentURL: "https://app.test/en/dashboard",
            effectiveDirective: "script-src",
            sourceFile: `https://app.test/assets/${jwt}/bundle.js`,
          },
        },
      ]);
      await POST(post(body, "application/reports+json"));
      const line = warnSpy.mock.calls[0]?.[0] as { sourceFile?: string };
      expect(line.sourceFile).toBe("https://app.test/assets/[redacted-token]/bundle.js");
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain(jwt);
    });

    it("redacts an email in the reported PATH and leaves CSP sentinels alone", async () => {
      const body = JSON.stringify([
        {
          type: "csp-violation",
          body: {
            // In the path, not the query — a query strip cannot save us here.
            documentURL: "https://app.test/en/u/victim@example.com/settings",
            effectiveDirective: "script-src-elem",
            blockedURL: "inline",
          },
        },
      ]);
      await POST(post(body, "application/reports+json"));
      const line = warnSpy.mock.calls[0]?.[0] as { documentUri?: string; blockedUri?: string };
      expect(line.documentUri).toBe("https://app.test/en/u/[redacted-email]/settings");
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain("victim@example.com");
      // `inline` / `eval` / `data` are spec sentinels, not URLs — untouched.
      expect(line.blockedUri).toBe("inline");
    });
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
