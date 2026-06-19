import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D4: server-side errors must reach Sentry. These pin the capture helper's
 * tagging and the rule that the error-response helpers capture a `cause`
 * ONLY for a 5xx — 4xx are expected client errors, not incidents.
 *
 * Mocked at the @sentry/nextjs boundary so both the direct helper and the
 * adminErrorResponse / problemResponse paths exercise the real wiring.
 */
const captureException = vi.hoisted(() => vi.fn(() => "evt-1" as string));
vi.mock("@sentry/nextjs", () => ({ captureException }));

import { captureServerError } from "@/lib/observability/server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { problemResponse } from "@/lib/api-auth/problem";

beforeEach(() => {
  captureException.mockReset();
  captureException.mockReturnValue("evt-1");
});
afterEach(() => vi.clearAllMocks());

describe("captureServerError", () => {
  it("tags the event with request_id, http_status, and endpoint", () => {
    const err = new Error("boom");
    const id = captureServerError(err, { requestId: "req-1", status: 502, endpoint: "/api/x" });
    expect(id).toBe("evt-1");
    expect(captureException).toHaveBeenCalledWith(err, {
      tags: { request_id: "req-1", http_status: "502", endpoint: "/api/x" },
    });
  });

  it("returns null when Sentry is disabled (empty event id)", () => {
    captureException.mockReturnValue("");
    expect(captureServerError(new Error("x"))).toBeNull();
  });

  it("omits tags that are absent", () => {
    captureServerError(new Error("x"), { requestId: null });
    expect(captureException).toHaveBeenCalledWith(expect.anything(), { tags: {} });
  });
});

describe("error-response helpers capture only a 5xx with a cause", () => {
  it("adminErrorResponse captures on 500 with a cause, tagged with request_id", () => {
    const err = new Error("db down");
    const res = adminErrorResponse("soft_delete_failed", 500, undefined, {
      requestId: "r1",
      cause: err,
    });
    expect(res.status).toBe(500);
    expect(captureException).toHaveBeenCalledWith(err, {
      tags: { request_id: "r1", http_status: "500" },
    });
  });

  it("adminErrorResponse does NOT capture on a 4xx even with a cause", () => {
    adminErrorResponse("invalid_body", 400, undefined, { requestId: "r1", cause: new Error("x") });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("adminErrorResponse does NOT capture on a 5xx with no cause", () => {
    adminErrorResponse("export_failed", 502, undefined, { requestId: "r1" });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("problemResponse captures on a 5xx with a cause", () => {
    const err = new Error("provider down");
    const res = problemResponse("internal_error", 502, undefined, { requestId: "r1", cause: err });
    expect(res.status).toBe(502);
    expect(captureException).toHaveBeenCalledWith(err, {
      tags: { request_id: "r1", http_status: "502" },
    });
  });
});
