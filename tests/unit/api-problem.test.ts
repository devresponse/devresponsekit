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

  it("review #204: `extra` can never override a reserved problem member", async () => {
    // A caller passing any of these — by accident, or because a value it is
    // forwarding happens to be named `status` — used to rewrite the document:
    // `extra` was spread LAST. A `status` that disagrees with the HTTP status,
    // or a `type` pointing somewhere else, silently breaks every client that
    // switches on them, and a rewritten `requestId` breaks log correlation.
    const res = problemResponse("not_found", 404, req, {
      detail: "the real detail",
      extra: {
        type: "https://evil.example/problems/spoofed",
        title: "Spoofed",
        status: 200,
        code: "spoofed",
        detail: "spoofed detail",
        requestId: "spoofed-request-id",
        // A genuinely extra member still rides along.
        resourceId: "abc",
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("https://devresponse.com/problems/not_found");
    expect(body.title).toBe("Resource not found");
    expect(body.status).toBe(404);
    expect(body.code).toBe("not_found");
    expect(body.detail).toBe("the real detail");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
    expect(body.requestId).not.toBe("spoofed-request-id");
    expect(body.resourceId).toBe("abc");
  });
});
