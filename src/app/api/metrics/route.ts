import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { registry, startDefaultMetrics } from "@/lib/observability/metrics.server";

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
 * `Authorization: Bearer <METRICS_TOKEN>`.
 */
function isAuthorized(request: Request): boolean {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return false; // fail closed: no token configured ⇒ endpoint disabled
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length));
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
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
