import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RouteModule from "@/app/api/internal/mcp-registration-reap/route";

/**
 * The serverless cron entrypoint for the MCP self-registration reaper
 * (`GET /api/internal/mcp-registration-reap`, review #13 / #51). Same
 * security contract as `outbox-drain`: the sweep runs ONLY for a caller
 * presenting the `CRON_SECRET` bearer and FAILS CLOSED when the secret is
 * unconfigured. The reaper is mocked; the env schema is REAL
 * (`vi.resetModules` re-parses it per test) so the ≥32-char rule on
 * `CRON_SECRET` and the `MCP_REGISTRATION_PENDING_TTL_DAYS` default/parse
 * are exercised end-to-end.
 */
const reapSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mcp/reaper.server", () => ({ expireStalePendingMcpRegistrations: reapSpy }));
vi.mock("@/lib/observability/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logServerError: vi.fn(),
}));

const SECRET = "test-cron-secret-value-at-least-32-chars-long";
let GET: typeof RouteModule.GET;

function req(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://localhost/api/internal/mcp-registration-reap", { headers });
}

beforeEach(async () => {
  reapSpy.mockReset();
  reapSpy.mockImplementation(async (ttlDays: number) => ({ expired: 4, ttlDays }));
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("MCP_REGISTRATION_PENDING_TTL_DAYS", "");
  ({ GET } = await import("@/app/api/internal/mcp-registration-reap/route"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("GET /api/internal/mcp-registration-reap", () => {
  it("reaps with the DEFAULT 7-day TTL and echoes the summary for a valid bearer", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(reapSpy).toHaveBeenCalledExactlyOnceWith(7);
    expect(await res.json()).toMatchObject({ ok: true, expired: 4, ttlDays: 7 });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("passes the configured MCP_REGISTRATION_PENDING_TTL_DAYS through", async () => {
    vi.stubEnv("MCP_REGISTRATION_PENDING_TTL_DAYS", "30");
    vi.resetModules();
    ({ GET } = await import("@/app/api/internal/mcp-registration-reap/route"));
    await GET(req(`Bearer ${SECRET}`));
    expect(reapSpy).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("rejects a wrong secret (401) and does NOT reap", async () => {
    const res = await GET(req("Bearer not-the-secret"));
    expect(res.status).toBe(401);
    expect(reapSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing Authorization header (401)", async () => {
    expect((await GET(req())).status).toBe(401);
    expect(reapSpy).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when CRON_SECRET is unset — even with a bearer header", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.resetModules();
    ({ GET } = await import("@/app/api/internal/mcp-registration-reap/route"));
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(401);
    expect(reapSpy).not.toHaveBeenCalled();
  });

  it("refuses to boot on a short CRON_SECRET instead of accepting it (review #92)", async () => {
    vi.stubEnv("CRON_SECRET", "x");
    vi.resetModules();
    ({ GET } = await import("@/app/api/internal/mcp-registration-reap/route"));
    await expect(GET(req("Bearer x"))).rejects.toThrow(/CRON_SECRET/);
    expect(reapSpy).not.toHaveBeenCalled();
  });

  it("returns 500 (not a silent 200) when the sweep throws", async () => {
    reapSpy.mockRejectedValue(new Error("db unavailable"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "reap_failed" });
  });
});
