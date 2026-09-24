import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `pnpm outbox:drain` (scripts/drain-outbox.ts) is a separate, short-lived
 * process with its own prom-client registry and no `/api/metrics`, so the
 * worker outcomes it counts are discarded when it exits (F-27 review). Its
 * operator-visible record is the per-row `email_delivery` log lines plus this
 * one summary line, which must therefore break out `expired`: only the worker
 * produces that outcome. The script runs `main()` on import, so the worker
 * and the pool are mocked and the import itself is the run.
 */

const drainOutbox = vi.fn();
const poolEnd = vi.fn(async () => {});

vi.mock("dotenv/config", () => ({}));
vi.mock("@/lib/email/outbox-worker.server", () => ({
  drainOutbox: (limit: number) => drainOutbox(limit),
}));
vi.mock("@/db/database", () => ({ pgPool: { end: () => poolEnd() } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("scripts/drain-outbox.ts summary line", () => {
  it("prints every DrainOutboxResult bucket, expired included, then closes the pool", async () => {
    vi.stubEnv("OUTBOX_DRAIN_LIMIT", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    drainOutbox.mockResolvedValue({ claimed: 6, sent: 2, retried: 1, failed: 3, expired: 2 });

    await import("../../scripts/drain-outbox");
    await vi.waitFor(() => expect(poolEnd).toHaveBeenCalledTimes(1));

    expect(drainOutbox).toHaveBeenCalledWith(100);
    expect(log.mock.calls).toEqual([["[outbox] claimed=6 sent=2 retried=1 failed=3 expired=2"]]);
    expect(process.exitCode).toBeUndefined();
  });
});
