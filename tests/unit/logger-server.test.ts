import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, logServerError } from "@/lib/observability/logger.server";

/**
 * Unit tests for the structured server logger (OBSERVABILITY-2). We replace
 * the pino instance's `error` method with a capture so we can assert the
 * shape `logServerError` emits, without writing to stdout.
 */
const errorCalls: unknown[][] = [];

beforeEach(() => {
  errorCalls.length = 0;
  vi.spyOn(logger, "error").mockImplementation(((...args: unknown[]) => {
    errorCalls.push(args);
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("logServerError", () => {
  it("serializes an Error to name/message/stack and carries the requestId", () => {
    logServerError("boom", { requestId: "req-1", err: new TypeError("bad input") });
    expect(errorCalls).toHaveLength(1);
    const [obj, msg] = errorCalls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("boom");
    expect(obj).toMatchObject({
      requestId: "req-1",
      err: { name: "TypeError", message: "bad input" },
    });
    expect(typeof (obj.err as { stack?: unknown }).stack).toBe("string");
  });

  it("serializes a non-Error thrown value", () => {
    logServerError("weird", { err: "just a string" });
    const [obj] = errorCalls[0] as [Record<string, unknown>];
    expect(obj).toMatchObject({ err: { value: "just a string" } });
  });

  it("omits err when none is given and forwards extra structured context", () => {
    logServerError("note", { requestId: "r", eventType: "x.y", outcome: "error" });
    const [obj] = errorCalls[0] as [Record<string, unknown>];
    expect(obj.err).toBeUndefined();
    expect(obj).toMatchObject({ requestId: "r", eventType: "x.y", outcome: "error" });
  });

  it("redacts emails and tokens in the error message/stack (audit #20)", () => {
    logServerError("boom", {
      err: new Error("resend 4xx for a@b.com using drk_live_ABC123 token"),
    });
    const [obj] = errorCalls[0] as [Record<string, unknown>];
    const err = obj.err as { message: string };
    expect(err.message).not.toContain("a@b.com");
    expect(err.message).not.toContain("drk_live_ABC123");
    expect(err.message).toContain("[redacted-email]");
    expect(err.message).toContain("[redacted-token]");
  });

  it("redacts a non-Error thrown value too", () => {
    logServerError("weird", { err: "token drk_live_XYZ leaked" });
    const [obj] = errorCalls[0] as [Record<string, unknown>];
    expect((obj.err as { value: string }).value).toBe("token [redacted-token] leaked");
  });
});
