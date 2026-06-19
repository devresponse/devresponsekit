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
});
