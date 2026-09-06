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

describe("review #204: adminErrorResponse reserved members", () => {
  it("`extra` can never override error / message / requestId", async () => {
    const res = adminErrorResponse("not_found", 404, req(), {
      extra: { error: "spoofed", message: "arbitrary text", requestId: "spoofed", detail: "kept" },
    });
    const body = (await res.json()) as Record<string, unknown>;
    // The machine code the client switches on and the `errors.*` i18n key the
    // frontend looks up must come from the CODE, never from caller data.
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("errors.not_found");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
    expect(body.requestId).not.toBe("spoofed");
    expect(body.detail).toBe("kept");
  });
});
