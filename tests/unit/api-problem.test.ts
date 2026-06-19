import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the observability sinks so we can assert problemResponse's wiring
// without a real pino stream / Sentry client.
const { logErr, capErr } = vi.hoisted(() => ({ logErr: vi.fn(), capErr: vi.fn() }));
vi.mock("@/lib/observability/logger.server", () => ({ logServerError: logErr }));
vi.mock("@/lib/observability/server", () => ({ captureServerError: capErr }));

import { problemResponse } from "@/lib/api-auth/problem";

/**
 * The RFC 7807 error envelope used by the /api/v1 surface.
 */
describe("problemResponse", () => {
  const req = { headers: new Headers() };

  afterEach(() => {
    logErr.mockReset();
    capErr.mockReset();
  });

  it("emits an application/problem+json document with stable fields", async () => {
    const res = problemResponse("forbidden", 403, req, { detail: "nope" });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden");
    expect(body.status).toBe(403);
    expect(body.title).toBe("Insufficient scope or permission");
    expect(body.detail).toBe("nope");
    expect(typeof body.requestId).toBe("string");
    expect(String(body.type)).toContain("/problems/forbidden");
  });

  it("merges extra members and custom headers", async () => {
    const res = problemResponse("rate_limited", 429, req, {
      extra: { retryAfter: 5 },
      headers: { "Retry-After": "5" },
    });
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.retryAfter).toBe(5);
  });

  it("logs every 5xx to stdout and captures to Sentry when a cause is present (OPS-OBS-2)", () => {
    const cause = new Error("boom");
    problemResponse("internal_error", 502, req, { cause });
    expect(logErr).toHaveBeenCalledWith(
      "v1.internal_error",
      expect.objectContaining({ status: 502, code: "internal_error", err: cause }),
    );
    expect(capErr).toHaveBeenCalledWith(cause, expect.objectContaining({ status: 502 }));
  });

  it("logs a 5xx even without a cause, but does not capture to Sentry", () => {
    problemResponse("internal_error", 500, req, {});
    expect(logErr).toHaveBeenCalledWith(
      "v1.internal_error",
      expect.objectContaining({ status: 500 }),
    );
    expect(capErr).not.toHaveBeenCalled();
  });

  it("never logs or captures a 4xx, even when a cause is supplied", () => {
    problemResponse("forbidden", 403, req, { cause: new Error("client error") });
    expect(logErr).not.toHaveBeenCalled();
    expect(capErr).not.toHaveBeenCalled();
  });
});
