import { NextResponse } from "next/server";
import { pgPool } from "@/db/database";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/ready — readiness probe.
 *
 * Verifies the app can reach its critical dependency (PostgreSQL) with a
 * fast `select 1`. Returns 200 when the database is reachable and 503 when
 * it is not, so an orchestrator's `readinessProbe` can gate traffic away
 * from an instance that cannot serve real requests (e.g. during a DB
 * outage or before the pool is warm) without restarting it.
 *
 * Unauthenticated and non-enumerating: on failure it returns a generic
 * `unavailable` status and never leaks the underlying database error. The
 * pool's `connectionTimeoutMillis` bounds how long a down database can hang
 * this check. `no-store` so the result is never cached.
 */
export async function GET() {
  try {
    await pgPool.query("select 1");
    return NextResponse.json({ status: "ready" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
