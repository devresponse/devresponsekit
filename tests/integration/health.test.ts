import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LivenessRoute from "@/app/api/health/route";
import type * as ReadinessRoute from "@/app/api/health/ready/route";

/**
 * Health probes (OPS-1):
 *   - GET /api/health        → liveness: always 200, never touches the DB.
 *   - GET /api/health/ready  → readiness: 200 when `select 1` succeeds,
 *                              503 when the pool query throws (DB down).
 */
const query = vi.fn();
vi.mock("@/db/database", () => ({ pgPool: { query: (...a: unknown[]) => query(...a) } }));

let liveness: typeof LivenessRoute;
let readiness: typeof ReadinessRoute;

beforeEach(async () => {
  query.mockReset();
  liveness = await import("@/app/api/health/route");
  readiness = await import("@/app/api/health/ready/route");
});
afterEach(() => vi.resetModules());

describe("GET /api/health (liveness)", () => {
  it("returns 200 + ok without querying the database", async () => {
    const res = liveness.GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("GET /api/health/ready (readiness)", () => {
  it("returns 200 + ready when the pool select 1 succeeds", async () => {
    query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const res = await readiness.GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ready" });
    expect(query).toHaveBeenCalledWith("select 1");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 503 + unavailable when the pool query throws, without leaking the error", async () => {
    query.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:5432"));
    const res = await readiness.GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "unavailable" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
