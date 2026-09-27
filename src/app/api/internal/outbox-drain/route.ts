import { NextResponse } from "next/server";
import { isOperatorBearerAuthorized } from "@/lib/operator-bearer.server";
import { drainOutbox, type DrainOutboxResult } from "@/lib/email/outbox-worker.server";
import { getServerEnv } from "@/lib/env";
import { logServerError, logger } from "@/lib/observability/logger.server";
import { pruneAll, type RetentionResult } from "@/lib/retention.server";
// Touches the pg pool + node:crypto, so it must run on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A drain makes up to a page of external provider calls (~10s each on a hung
// provider), so bound the wall-clock. Route-segment `maxDuration` is clamped to
// the plan's ceiling rather than failing the build — unlike `vercel.json`
// `functions`, which for a Next.js App Router route does not match and errors.
export const maxDuration = 60;
/**
 * How far into a tick the retention prune may still START a batch (F-96). The
 * drain runs first and retention gets what is left of this window, so a slow
 * drain shortens it and one that overruns it skips retention for that tick.
 * The 15s to `maxDuration` covers the batch in flight (each is small and
 * indexed on `created_at`) and the response. A backlog bigger than one window
 * is finished by the following days' ticks: every batch commits on its own.
 */
const RETENTION_DEADLINE_MS = 45_000;

/**
 * GET /api/internal/outbox-drain — scheduler entrypoint for the email outbox
 * retry worker, and for data retention.
 *
 * On a serverless host (e.g. Vercel) there is no long-running process to run
 * `pnpm outbox:drain`, so a scheduled trigger — a Vercel Cron Job, declared in
 * `vercel.json` — calls this route on an interval. It re-attempts the
 * `pending` rows `sendAppEmail` left for retry (see `outbox-worker.server.ts`),
 * then runs the retention prune (`pruneAll`, see `retention.server.ts`) —
 * the job `pnpm db:prune` does elsewhere, which on Vercel nothing ran (F-96).
 * It rides this cron rather than a third `vercel.json` entry, so the drain and
 * the prune share one invocation and the time budget below.
 *
 * It is NOT user-facing: it is gated by the shared `CRON_SECRET` bearer
 * (see `src/lib/operator-bearer.server.ts` — constant-time compare, FAILS CLOSED
 * when the secret is unset, ≥32 chars enforced at boot; review #92). Vercel
 * Cron attaches `Authorization: Bearer <CRON_SECRET>` automatically when that
 * env var is set.
 */
function noStore(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  if (!isOperatorBearerAuthorized(request, getServerEnv().CRON_SECRET)) {
    return noStore({ error: "unauthorized" }, 401);
  }

  let drain: DrainOutboxResult | null = null;
  try {
    drain = await drainOutbox();
    logger.info({ kind: "outbox-drain", ...drain }, "outbox drain tick");
  } catch (err) {
    logServerError("outbox drain tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Its own try/catch (F-96): a failed drain must not skip retention, nor a
  // failed prune hide a drain that worked. Either failure answers 500, so the
  // Vercel cron log shows the tick as failed.
  let retention: RetentionResult | null = null;
  try {
    retention = await pruneAll({ deadline: startedAt + RETENTION_DEADLINE_MS });
    logger.info({ kind: "retention", ...retention }, "retention prune tick");
  } catch (err) {
    logServerError("retention prune tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!drain) {
    return noStore({ ok: false, error: "drain_failed", ...(retention ? { retention } : {}) }, 500);
  }
  if (!retention) {
    return noStore({ ok: false, error: "retention_failed", ...drain }, 500);
  }
  return noStore({ ok: true, ...drain, retention }, 200);
}
