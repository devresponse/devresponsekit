import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { registry, startDefaultMetrics } from "@/lib/observability/metrics.server";
import { isOperatorBearerAuthorized } from "@/lib/operator-bearer.server";

// Reads the prom-client registry (Node-only) and node:crypto.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/metrics — Prometheus scrape endpoint (observability epic #52).
 *
 * Exposes the process + business metrics in the Prometheus text exposition
 * format. NOT public: gated by a `METRICS_TOKEN` bearer compared in constant
 * time, and **fails closed** when the token is unset, so a deployment that
 * forgets to configure it never leaks metrics (which can carry route names,
 * counts, and timing). Point your scraper at it with
 * `Authorization: Bearer <METRICS_TOKEN>`. The token is read through the
 * validated env (`src/lib/env.ts`: optional, ≥32 chars when set, empty =
 * unset) so a short guessable value fails at boot (review #222). The check is
 * the one the cron routes use (`src/lib/operator-bearer.server.ts`), not a
 * copy of it (I-08).
 */
export async function GET(request: Request): Promise<Response> {
  if (!isOperatorBearerAuthorized(request, getServerEnv().METRICS_TOKEN)) {
    return new NextResponse("unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }

  startDefaultMetrics();
  const body = await registry.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": registry.contentType, "cache-control": "no-store" },
  });
}
