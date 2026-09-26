import { NextResponse } from "next/server";
import { isOperatorBearerAuthorized } from "@/lib/operator-bearer.server";
import { getServerEnv } from "@/lib/env";
import { expireStalePendingMcpRegistrations } from "@/lib/mcp/reaper.server";
import { logServerError, logger } from "@/lib/observability/logger.server";

// Touches the pg pool + node:crypto, so it must run on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Within every plan's ceiling. The reaper works in batches and is handed a
// deadline well inside this (F-75), so a backlog bigger than one tick can
// drain is finished by the next tick instead of timing the function out.
export const maxDuration = 60;
/**
 * How long one tick keeps starting batches (F-75). Leaves `maxDuration` room
 * for a cold start and for the batch in hand to commit and write its audit rows.
 */
const REAP_TIME_BUDGET_MS = 40_000;

/**
 * GET /api/internal/mcp-registration-reap — scheduler entrypoint for the MCP
 * self-registration reaper (review #13, #51).
 *
 * Expires self-registered agents still `pending_approval` after
 * `MCP_REGISTRATION_PENDING_TTL_DAYS` (default 7; 0 disables), so junk
 * registrations from the public `POST /api/mcp/register` endpoint do not
 * accumulate in the Agents console. Same pattern as `outbox-drain`: on a
 * serverless host a Vercel Cron Job declared in `vercel.json` calls this
 * route daily; elsewhere run `pnpm mcp:reap` from a cron / CronJob.
 *
 * NOT user-facing: gated by the shared `CRON_SECRET` bearer
 * (`src/lib/operator-bearer.server.ts` — constant-time, FAILS CLOSED when unset).
 * It runs even while registration is dark: leftovers from an earlier open
 * window are exactly what it exists to clean up.
 */
function noStore(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<NextResponse> {
  const env = getServerEnv();
  if (!isOperatorBearerAuthorized(request, env.CRON_SECRET)) {
    return noStore({ error: "unauthorized" }, 401);
  }

  try {
    const result = await expireStalePendingMcpRegistrations(env.MCP_REGISTRATION_PENDING_TTL_DAYS, {
      deadline: Date.now() + REAP_TIME_BUDGET_MS,
    });
    logger.info({ kind: "mcp-registration-reap", ...result }, "mcp registration reap tick");
    return noStore({ ok: true, ...result }, 200);
  } catch (err) {
    logServerError("mcp registration reap tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return noStore({ ok: false, error: "reap_failed" }, 500);
  }
}
