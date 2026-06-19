import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D5: the process-level crash handlers must log + capture to Sentry + flush +
 * exit(1), so a stray rejection/exception is never silent. process.on / exit
 * are stubbed so invoking a captured handler doesn't kill the test runner.
 */
const captureException = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@sentry/nextjs", () => ({ captureException, flush }));
const logServerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/logger.server", () => ({ logServerError }));

describe("registerProcessErrorHandlers (D5)", () => {
  const handlers = new Map<string, (arg: unknown) => void>();

  beforeEach(() => {
    handlers.clear();
    captureException.mockClear();
    flush.mockClear();
    logServerError.mockClear();
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      handlers.set(String(event), listener as (arg: unknown) => void);
      return process;
    });
    vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("registers handlers for both fatal events", async () => {
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();
    expect(handlers.has("uncaughtException")).toBe(true);
    expect(handlers.has("unhandledRejection")).toBe(true);
  });

  it("logs, captures, flushes, and exits non-zero on uncaughtException", async () => {
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();
    const err = new Error("boom");

    handlers.get("uncaughtException")!(err);

    expect(logServerError).toHaveBeenCalledWith(
      "process.uncaughtException",
      expect.objectContaining({ err, fatal: true }),
    );
    expect(captureException).toHaveBeenCalledWith(err, { tags: { kind: "uncaughtException" } });
    expect(flush).toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(process.exit)).toHaveBeenCalledWith(1));
  });

  it("handles unhandledRejection the same way", async () => {
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();

    handlers.get("unhandledRejection")!("rejected");

    expect(captureException).toHaveBeenCalledWith("rejected", {
      tags: { kind: "unhandledRejection" },
    });
    await vi.waitFor(() => expect(vi.mocked(process.exit)).toHaveBeenCalledWith(1));
  });

  it("is idempotent — does not double-register", async () => {
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();
    const afterFirst = vi.mocked(process.on).mock.calls.length;
    registerProcessErrorHandlers();
    expect(vi.mocked(process.on).mock.calls.length).toBe(afterFirst);
  });
});
