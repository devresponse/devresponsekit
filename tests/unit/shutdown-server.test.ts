import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ShutdownModule from "@/lib/shutdown.server";

/**
 * Unit tests for graceful shutdown (OPS-4). The pg pool and logger are
 * mocked; `exit` is injected so the test runner is never actually killed.
 */
const poolEnd = vi.fn();
vi.mock("@/db/database", () => ({ pgPool: { end: (...a: unknown[]) => poolEnd(...a) } }));
vi.mock("@/lib/observability/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let mod: typeof ShutdownModule;

beforeEach(async () => {
  vi.resetModules(); // reset the module-level registered/shuttingDown flags
  poolEnd.mockReset();
  poolEnd.mockResolvedValue(undefined);
  mod = await import("@/lib/shutdown.server");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("gracefulShutdown", () => {
  it("drains the pool, then exits 0", async () => {
    const exit = vi.fn();
    await mod.gracefulShutdown("SIGTERM", exit);
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 when draining the pool throws", async () => {
    poolEnd.mockRejectedValue(new Error("pool boom"));
    const exit = vi.fn();
    await mod.gracefulShutdown("SIGTERM", exit);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a second concurrent signal (re-entrant safe)", async () => {
    const exit = vi.fn();
    await Promise.all([
      mod.gracefulShutdown("SIGTERM", exit),
      mod.gracefulShutdown("SIGINT", exit),
    ]);
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits after the bounded timeout if the drain hangs", async () => {
    vi.useFakeTimers();
    poolEnd.mockReturnValue(new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();
    void mod.gracefulShutdown("SIGTERM", exit);
    await vi.advanceTimersByTimeAsync(10_000); // default SHUTDOWN_TIMEOUT_MS
    expect(exit).toHaveBeenCalledWith(0);
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
});
