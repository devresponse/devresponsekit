import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ShutdownModule from "@/lib/shutdown.server";

/**
 * Unit tests for the shutdown watchdog (OPS-4, review #24). The pg pool and
 * logger are mocked; `exit` is injected so the test runner is never killed.
 *
 * The contract under test: on SIGTERM/SIGINT the module must NOT end the pool
 * and must NOT exit — Next's own cleanup drains HTTP and exits 143/130 — and
 * only once SHUTDOWN_TIMEOUT_MS has elapsed (Next's drain overran) may it end
 * the pool and exit with the 128+signal code, never 0. The real-process
 * ordering proof (an in-flight request completes across the signal) lives in
 * tests/db/shutdown-lifecycle.db.test.ts.
 */
const poolEnd = vi.fn();
vi.mock("@/db/database", () => ({
  pgPool: { end: (...a: unknown[]) => poolEnd(...a), totalCount: 2, idleCount: 1, waitingCount: 0 },
}));
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/observability/logger.server", () => ({ logger: logs }));

let mod: typeof ShutdownModule;
const ORIGINAL_VERCEL = process.env.VERCEL;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules(); // reset the module-level registered/shuttingDown flags
  poolEnd.mockReset();
  poolEnd.mockResolvedValue(undefined);
  logs.info.mockClear();
  logs.warn.mockClear();
  logs.error.mockClear();
  delete process.env.VERCEL;
  mod = await import("@/lib/shutdown.server");
});
afterEach(() => {
  if (ORIGINAL_VERCEL === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = ORIGINAL_VERCEL;
  vi.useRealTimers();
});

describe("gracefulShutdown", () => {
  it("does NOT end the pool and does NOT exit on the signal (Next owns the HTTP drain)", async () => {
    const exit = vi.fn();
    mod.gracefulShutdown("SIGTERM", exit);
    // Well inside the budget: an in-flight request may still check clients out.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(poolEnd).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", timeoutMs: 10_000 }),
      expect.stringContaining("watchdog armed"),
    );
  });

  it("ends the pool and exits 143 only once SHUTDOWN_TIMEOUT_MS elapses on SIGTERM", async () => {
    const exit = vi.fn();
    mod.gracefulShutdown("SIGTERM", exit);
    await vi.advanceTimersByTimeAsync(10_000); // default SHUTDOWN_TIMEOUT_MS
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
    expect(exit).not.toHaveBeenCalledWith(0);
    // The pool end is kicked BEFORE the exit so idle clients get a Terminate.
    expect(poolEnd.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]!);
  });

  it("exits 130 (not 0) when the watchdog fires for SIGINT", async () => {
    const exit = vi.fn();
    mod.gracefulShutdown("SIGINT", exit);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("still exits with the signal code when ending the pool rejects", async () => {
    poolEnd.mockRejectedValue(new Error("pool boom"));
    const exit = vi.fn();
    mod.gracefulShutdown("SIGTERM", exit);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledWith(143);
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: "pool boom" }) }),
      expect.stringContaining("error ending database pool"),
    );
  });

  it("does not wait for a hung pool.end() — the budget is the hard bound", async () => {
    poolEnd.mockReturnValue(new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();
    mod.gracefulShutdown("SIGTERM", exit);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("ignores a second signal (re-entrant safe): one watchdog, one exit", async () => {
    const exit = vi.fn();
    mod.gracefulShutdown("SIGTERM", exit);
    mod.gracefulShutdown("SIGINT", exit);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143); // the FIRST signal's code
  });

  it("unrefs the watchdog timer so it never keeps the process alive by itself", () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setTimeout>);
    try {
      mod.gracefulShutdown("SIGTERM", vi.fn());
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("registerGracefulShutdown", () => {
  it("registers SIGTERM + SIGINT exactly once (idempotent)", () => {
    const once = vi.spyOn(process, "once").mockImplementation((() => process) as never);
    try {
      mod.registerGracefulShutdown();
      mod.registerGracefulShutdown(); // second call is a no-op
      expect(once.mock.calls.map((c) => c[0])).toEqual(["SIGTERM", "SIGINT"]);
    } finally {
      once.mockRestore();
    }
  });

  it("the registered listener arms the watchdog for the signal it received", async () => {
    const listeners = new Map<string, () => void>();
    const once = vi.spyOn(process, "once").mockImplementation(((event: string, fn: () => void) => {
      listeners.set(event, fn);
      return process;
    }) as never);
    const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
    try {
      mod.registerGracefulShutdown();
      listeners.get("SIGINT")!();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(poolEnd).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      once.mockRestore();
      exit.mockRestore();
    }
  });

  it("registers nothing on Vercel (serverless never drains this way)", async () => {
    process.env.VERCEL = "1";
    vi.resetModules();
    mod = await import("@/lib/shutdown.server");
    const once = vi.spyOn(process, "once").mockImplementation((() => process) as never);
    try {
      mod.registerGracefulShutdown();
      expect(once).not.toHaveBeenCalled();
    } finally {
      once.mockRestore();
    }
  });
});
