import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RouteModule from "@/app/api/internal/outbox-drain/route";

/**
 * The serverless cron entrypoint for the email outbox drainer
 * (`GET /api/internal/outbox-drain`). The contract is security-critical: it
 * must run the drain ONLY for a caller presenting the `CRON_SECRET` bearer, and
 * must **fail closed** when the secret is unconfigured (Vercel Cron sends the
 * request unauthenticated in that case). The drainer itself is mocked; the
 * env schema is REAL (`vi.resetModules` re-parses it per test) so the
 * ≥32-char rule on `CRON_SECRET` is exercised end-to-end (review #92).
 */
const drainSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/outbox-worker.server", () => ({ drainOutbox: drainSpy }));
vi.mock("@/lib/observability/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logServerError: vi.fn(),
}));

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
  vi.stubEnv("CRON_SECRET", SECRET);
  ({ GET } = await import("@/app/api/internal/outbox-drain/route"));
});
afterEach(() => {
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

  it("rejects a wrong secret (401) and does NOT drain", async () => {
    const res = await GET(req("Bearer not-the-secret"));
    expect(res.status).toBe(401);
    expect(drainSpy).not.toHaveBeenCalled();
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
