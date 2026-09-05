import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D5 / review #23: the process-level handlers must log + capture to Sentry so
 * a stray rejection/exception is never silent — but they must NOT exit the
 * process, because Next 16 deliberately treats both events as non-fatal
 * (`next/dist/server/node-environment-extensions/process-error-handlers.js`)
 * and a `process.exit(1)` would turn one late-awaited prefetch rejection into
 * a restart of the whole server. Exit-on-uncaught is opt-in via
 * `PROCESS_FATAL_ON_UNCAUGHT=1`. process.on / exit are stubbed so invoking a
 * captured handler doesn't touch the test runner.
 */
const captureException = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@sentry/nextjs", () => ({ captureException, flush }));
const logServerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/logger.server", () => ({ logServerError }));

describe("registerProcessErrorHandlers (D5, review #23)", () => {
  const handlers = new Map<string, (arg: unknown) => void>();
  const ORIGINAL_FLAG = process.env.PROCESS_FATAL_ON_UNCAUGHT;

  beforeEach(() => {
    handlers.clear();
    captureException.mockClear();
    flush.mockClear();
    logServerError.mockClear();
    delete process.env.PROCESS_FATAL_ON_UNCAUGHT;
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      handlers.set(String(event), listener as (arg: unknown) => void);
      return process;
    });
    vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  });
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.PROCESS_FATAL_ON_UNCAUGHT;
    else process.env.PROCESS_FATAL_ON_UNCAUGHT = ORIGINAL_FLAG;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** Lets any `.then/.finally` chain the handler may have started settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("registers handlers for both events", async () => {
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();
    expect(handlers.has("uncaughtException")).toBe(true);
    expect(handlers.has("unhandledRejection")).toBe(true);
  });

  it("unhandledRejection: logged + captured, never exits", async () => {
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();

    handlers.get("unhandledRejection")!("rejected");
    await settle();

    expect(logServerError).toHaveBeenCalledWith(
      "process.unhandledRejection",
      expect.objectContaining({ err: "rejected", fatal: false }),
    );
    expect(captureException).toHaveBeenCalledWith("rejected", {
      tags: { kind: "unhandledRejection" },
    });
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("unhandledRejection never exits even when PROCESS_FATAL_ON_UNCAUGHT=1", async () => {
    process.env.PROCESS_FATAL_ON_UNCAUGHT = "1";
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();

    handlers.get("unhandledRejection")!(new Error("late prefetch"));
    await settle();

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("uncaughtException: logged + captured, no exit by default", async () => {
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();
    const err = new Error("boom");

    handlers.get("uncaughtException")!(err);
    await settle();

    expect(logServerError).toHaveBeenCalledWith(
      "process.uncaughtException",
      expect.objectContaining({ err, fatal: false }),
    );
    expect(captureException).toHaveBeenCalledWith(err, { tags: { kind: "uncaughtException" } });
    expect(flush).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it.each(["1", "true"])(
    "uncaughtException with PROCESS_FATAL_ON_UNCAUGHT=%s: captured, flushed, then exit(1)",
    async (flag) => {
      process.env.PROCESS_FATAL_ON_UNCAUGHT = flag;
      const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
      registerProcessErrorHandlers();
      const err = new Error("boom");

      handlers.get("uncaughtException")!(err);

      expect(logServerError).toHaveBeenCalledWith(
        "process.uncaughtException",
        expect.objectContaining({ err, fatal: true }),
      );
      expect(captureException).toHaveBeenCalledWith(err, { tags: { kind: "uncaughtException" } });
      expect(flush).toHaveBeenCalledWith(2000);
      await vi.waitFor(() => expect(vi.mocked(process.exit)).toHaveBeenCalledWith(1));
      // The capture happened BEFORE the exit (the exit is chained off the flush).
      expect(captureException.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(process.exit).mock.invocationCallOrder[0]!,
      );
    },
  );

  it("still exits when the Sentry flush rejects (flag on)", async () => {
    process.env.PROCESS_FATAL_ON_UNCAUGHT = "1";
    flush.mockImplementationOnce(() => Promise.reject(new Error("no transport")));
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();

    handlers.get("uncaughtException")!(new Error("boom"));

    await vi.waitFor(() => expect(vi.mocked(process.exit)).toHaveBeenCalledWith(1));
  });

  it("a non-boolean flag value does not opt in", async () => {
    process.env.PROCESS_FATAL_ON_UNCAUGHT = "yes";
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();

    handlers.get("uncaughtException")!(new Error("boom"));
    await settle();

    expect(process.exit).not.toHaveBeenCalled();
  });

  it("swallows a throwing logger/capture (the handler itself must never throw)", async () => {
    logServerError.mockImplementationOnce(() => {
      throw new Error("logger down");
    });
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();

    expect(() => handlers.get("uncaughtException")!(new Error("boom"))).not.toThrow();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("is idempotent — does not double-register", async () => {
    const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
    registerProcessErrorHandlers();
    const afterFirst = vi.mocked(process.on).mock.calls.length;
    registerProcessErrorHandlers();
    expect(vi.mocked(process.on).mock.calls.length).toBe(afterFirst);
  });
});
