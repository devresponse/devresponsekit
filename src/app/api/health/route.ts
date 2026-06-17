import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness probe.
 *
 * Returns 200 as long as the Node process is up and serving requests. It
 * deliberately does NOT touch the database or any other dependency — that is
 * the readiness probe's job (`/api/health/ready`). Use this for an
 * orchestrator's `livenessProbe`: a failure here means "restart the
 * container", not "stop routing traffic".
 *
 * Unauthenticated and non-enumerating: it reveals only that the server is
 * alive. `no-store` so a CDN/proxy never serves a cached "ok".
 */
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
