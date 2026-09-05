import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth.server";
import { drainOutbox } from "@/lib/email/outbox-worker.server";
import { getServerEnv } from "@/lib/env";
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
 * It is NOT user-facing: it is gated by the shared `CRON_SECRET` bearer
 * (see `src/lib/cron-auth.server.ts` — constant-time compare, FAILS CLOSED
 * when the secret is unset, ≥32 chars enforced at boot; review #92). Vercel
 * Cron attaches `Authorization: Bearer <CRON_SECRET>` automatically when that
 * env var is set.
 */
function noStore(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorized(request, getServerEnv().CRON_SECRET)) {
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
