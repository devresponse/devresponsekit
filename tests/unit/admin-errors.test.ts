import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OPS-OBS-2 for the ADMIN error surface (audit #9). `adminErrorResponse` must
 * mirror its v1 twin `problemResponse`: every 5xx reaches the always-on stdout
 * logger (`logServerError`), not just Sentry — so a default no-DSN deploy is
 * not blind to its own 500s — while Sentry capture stays gated on a `cause`.
 */
vi.mock("@/lib/observability/logger.server", () => ({ logServerError: vi.fn() }));
vi.mock("@/lib/observability/server", () => ({ captureServerError: vi.fn() }));

import { adminErrorResponse } from "@/lib/admin/errors.server";
import { logServerError } from "@/lib/observability/logger.server";
import { captureServerError } from "@/lib/observability/server";

const log = vi.mocked(logServerError);
const capture = vi.mocked(captureServerError);

function req(): { headers: Headers } {
  return { headers: new Headers() };
}

beforeEach(() => {
  log.mockReset();
  capture.mockReset();
});

describe("adminErrorResponse observability", () => {
  it("logs EVERY 5xx to stdout, even without a cause", () => {
    const res = adminErrorResponse("internal_error", 500, req());
    expect(res.status).toBe(500);
    expect(log).toHaveBeenCalledWith(
      "admin.internal_error",
      expect.objectContaining({ status: 500, code: "internal_error" }),
    );
    // No cause → no Sentry capture (matches D4).
    expect(capture).not.toHaveBeenCalled();
  });

  it("also captures to Sentry when a cause is supplied", () => {
    adminErrorResponse("internal_error", 502, req(), { cause: new Error("boom") });
    expect(log).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does NOT log or capture 4xx client errors", () => {
    adminErrorResponse("forbidden", 403, req());
    expect(log).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
