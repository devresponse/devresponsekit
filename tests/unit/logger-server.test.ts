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
});
