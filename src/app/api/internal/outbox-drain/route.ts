import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { drainOutbox } from "@/lib/email/outbox-worker.server";
import { logServerError, logger } from "@/lib/observability/logger.server";

// Touches the pg pool + node:crypto, so it must run on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A drain makes up to a page of external provider calls (~10s each on a hung
// provider), so bound the wall-clock. Route-segment `maxDuration` is clamped to
// the plan's ceiling rather than failing the build — unlike `vercel.json`
// `functions`, which for a Next.js App Router route does not match and errors.
export const maxDuration = 60;

/**
 * GET /api/internal/outbox-drain — scheduler entrypoint for the email outbox
 * retry worker.
 *
 * On a serverless host (e.g. Vercel) there is no long-running process to run
 * `pnpm outbox:drain`, so a scheduled trigger — a Vercel Cron Job, declared in
 * `vercel.json` — calls this route on an interval. It re-attempts the
 * `pending` rows `sendAppEmail` left for retry (see `outbox-worker.server.ts`).
 *
 * It is NOT user-facing: it is gated by a shared secret in `CRON_SECRET`,
 * compared in constant time. Vercel Cron automatically attaches
 * `Authorization: Bearer <CRON_SECRET>` when that env var is set. The route
 * **fails closed** when `CRON_SECRET` is unset, so a deployment that forgets to
 * configure the secret never exposes an unauthenticated drain trigger (rather
 * than silently allowing one, which is how Vercel Cron behaves without it).
 */
function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  // Fail closed: with no secret configured the endpoint is never callable.
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const presented = Buffer.from(header.slice(prefix.length));
  const secret = Buffer.from(expected);
  // Length-guard first: timingSafeEqual throws on a length mismatch (which
  // would itself leak the length), so compare lengths before the constant-time
  // byte comparison.
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

function noStore(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return noStore({ error: "unauthorized" }, 401);
  }

  try {
    const result = await drainOutbox();
    logger.info({ kind: "outbox-drain", ...result }, "outbox drain tick");
    return noStore({ ok: true, ...result }, 200);
  } catch (err) {
    logServerError("outbox drain tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return noStore({ ok: false, error: "drain_failed" }, 500);
  }
}
