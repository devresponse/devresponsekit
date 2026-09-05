import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LivenessRoute from "@/app/api/health/route";
import type * as ReadinessRoute from "@/app/api/health/ready/route";
import { REQUIRED_CORE_MIGRATIONS } from "@/db/migrations/migration-plan";

/**
 * Health probes (OPS-1):
 *   - GET /api/health        → liveness: always 200, never touches the DB.
 *   - GET /api/health/ready  → readiness: 200 when the ledger holds every
 *                              core migration this build needs, 503
 *                              `schema_behind` when one is missing (review
 *                              #43 landing gate — a build promoted ahead of
 *                              its migration), 503 `database_unreachable`
 *                              when the pool query throws (DB down).
 */
const query = vi.fn();
const logServerError = vi.fn();
vi.mock("@/db/database", () => ({ pgPool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logServerError(...a),
}));

const ledgerRows = (ids: readonly string[]) => ({ rows: ids.map((id) => ({ id })) });

let liveness: typeof LivenessRoute;
let readiness: typeof ReadinessRoute;

beforeEach(async () => {
  query.mockReset();
  logServerError.mockReset();
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
  it("returns 200 + ready when the ledger holds every required core migration", async () => {
    query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));
    const res = await readiness.GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ready" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(logServerError).not.toHaveBeenCalled();
  });

  it("asks the ledger for exactly the build's required core ids, in ONE query", async () => {
    query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));
    await readiness.GET();
    expect(query).toHaveBeenCalledTimes(1);
    const [text, params] = query.mock.calls[0] as [string, unknown[]];
    expect(text).toContain("app_schema_migrations");
    expect(params).toEqual([REQUIRED_CORE_MIGRATIONS]);
    // The gate is only as good as the list: 0004 (the migration production
    // ran ahead of) MUST be in it.
    expect(REQUIRED_CORE_MIGRATIONS).toContain("0004-oauth-client-secret-rotated-at.sql");
  });

  it("returns 503 + schema_behind when a required core migration is missing, naming it only in the log", async () => {
    const missing = "0004-oauth-client-secret-rotated-at.sql";
    query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS.filter((id) => id !== missing)));
    const res = await readiness.GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "unavailable", reason: "schema_behind" });
    // Non-enumerating: the response never lists migration ids...
    expect(JSON.stringify(body)).not.toContain("0004");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // ...but the operator sees exactly which ones are missing in the log.
    expect(logServerError).toHaveBeenCalledTimes(1);
    const [, fields] = logServerError.mock.calls[0] as [string, { missing: string[] }];
    expect(fields.missing).toEqual([missing]);
  });

  it("treats an empty ledger (never-migrated database) as schema_behind, not ready", async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await readiness.GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ status: "unavailable", reason: "schema_behind" });
    const [, fields] = logServerError.mock.calls[0] as [string, { missing: string[] }];
    expect(fields.missing).toEqual([...REQUIRED_CORE_MIGRATIONS]);
  });

  it("returns 503 + database_unreachable when the pool query throws, without leaking the error", async () => {
    query.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:5432"));
    const res = await readiness.GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "unavailable", reason: "database_unreachable" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(logServerError).not.toHaveBeenCalled();
  });
});
