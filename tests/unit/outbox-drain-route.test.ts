import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RouteModule from "@/app/api/internal/outbox-drain/route";

/**
 * The serverless cron entrypoint for the email outbox drainer
 * (`GET /api/internal/outbox-drain`). The contract is security-critical: it
 * must run the drain ONLY for a caller presenting the `CRON_SECRET` bearer, and
 * must **fail closed** when the secret is unconfigured (Vercel Cron sends the
 * request unauthenticated in that case). The drainer and the retention prune
 * it now also runs (F-96) are mocked; the env schema is REAL
 * (`vi.resetModules` re-parses it per test) so the ≥32-char rule on
 * `CRON_SECRET` is exercised end-to-end (review #92).
 */
const drainSpy = vi.hoisted(() => vi.fn());
const pruneSpy = vi.hoisted(() => vi.fn());
const logServerErrorSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/outbox-worker.server", () => ({ drainOutbox: drainSpy }));
vi.mock("@/lib/retention.server", () => ({ pruneAll: pruneSpy }));
vi.mock("@/lib/observability/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logServerError: logServerErrorSpy,
}));

const RETENTION = {
  revocations: 0,
  auditEvents: 4,
  outbox: 120,
  staleOutboxFailed: 2,
  ssoNonces: 1,
};

const SECRET = "test-cron-secret-value-at-least-32-chars-long";
let GET: typeof RouteModule.GET;

function req(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://localhost/api/internal/outbox-drain", { headers });
}

beforeEach(async () => {
  drainSpy.mockReset();
  drainSpy.mockResolvedValue({ claimed: 3, sent: 2, retried: 1, failed: 0 });
  pruneSpy.mockReset();
  pruneSpy.mockResolvedValue(RETENTION);
  logServerErrorSpy.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
  ({ GET } = await import("@/app/api/internal/outbox-drain/route"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("GET /api/internal/outbox-drain", () => {
  it("drains and echoes the summary for a valid bearer secret", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(drainSpy).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ ok: true, claimed: 3, sent: 2, retried: 1 });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a wrong secret (401) and does NOT drain or prune", async () => {
    const res = await GET(req("Bearer not-the-secret"));
    expect(res.status).toBe(401);
    expect(drainSpy).not.toHaveBeenCalled();
    expect(pruneSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing Authorization header (401)", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(drainSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-Bearer scheme (401)", async () => {
    const res = await GET(req(`Basic ${SECRET}`));
    expect(res.status).toBe(401);
    expect(drainSpy).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when CRON_SECRET is unset — even with a bearer header", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(401);
    expect(drainSpy).not.toHaveBeenCalled();
    expect(pruneSpy).not.toHaveBeenCalled();
  });

  it("refuses to boot on a short CRON_SECRET instead of accepting it (review #92)", async () => {
    // A one-character secret must fail env validation, never authorize a drain.
    vi.stubEnv("CRON_SECRET", "x");
    await expect(GET(req("Bearer x"))).rejects.toThrow(/CRON_SECRET/);
    expect(drainSpy).not.toHaveBeenCalled();
  });

  it("returns 500 (not a silent 200) when the drain throws", async () => {
    drainSpy.mockRejectedValue(new Error("db unavailable"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});

describe("GET /api/internal/outbox-drain — retention (F-96)", () => {
  it("runs the retention prune after the drain and reports it", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(pruneSpy).toHaveBeenCalledOnce();
    expect(drainSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      pruneSpy.mock.invocationCallOrder[0]!,
    );
    expect(await res.json()).toMatchObject({ ok: true, claimed: 3, retention: RETENTION });
  });

  it("bounds the prune with a deadline 45s after the tick started, drain time included", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    // A 30s drain: the deadline stays anchored at the start of the tick, so
    // retention gets the 15s left, never a fresh 45s past the 60s maxDuration.
    drainSpy.mockImplementation(async () => {
      vi.setSystemTime(1_030_000);
      return { claimed: 0, sent: 0, retried: 0, failed: 0 };
    });
    await GET(req(`Bearer ${SECRET}`));
    expect(pruneSpy).toHaveBeenCalledWith({ deadline: 1_045_000 });
  });

  it("still prunes when the drain throws, and answers 500 drain_failed", async () => {
    drainSpy.mockRejectedValue(new Error("db unavailable"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(pruneSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "drain_failed",
      retention: RETENTION,
    });
  });

  it("answers 500 retention_failed when the prune throws, keeping the drain summary", async () => {
    pruneSpy.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(drainSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "retention_failed", claimed: 3 });
    expect(logServerErrorSpy).toHaveBeenCalledWith("retention prune tick failed", {
      error: "canceling statement due to statement timeout",
    });
  });
});
