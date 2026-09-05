import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth.server";
import { getServerEnv } from "@/lib/env";
import { expireStalePendingMcpRegistrations } from "@/lib/mcp/reaper.server";
import { logServerError, logger } from "@/lib/observability/logger.server";

// Touches the pg pool + node:crypto, so it must run on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Three bounded UPDATEs; well inside every plan's ceiling.
export const maxDuration = 60;

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
 * (`src/lib/cron-auth.server.ts` — constant-time, FAILS CLOSED when unset).
 * It runs even while registration is dark: leftovers from an earlier open
 * window are exactly what it exists to clean up.
 */
function noStore(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<NextResponse> {
  const env = getServerEnv();
  if (!isCronAuthorized(request, env.CRON_SECRET)) {
    return noStore({ error: "unauthorized" }, 401);
  }

  try {
    const result = await expireStalePendingMcpRegistrations(env.MCP_REGISTRATION_PENDING_TTL_DAYS);
    logger.info({ kind: "mcp-registration-reap", ...result }, "mcp registration reap tick");
    return noStore({ ok: true, ...result }, 200);
  } catch (err) {
    logServerError("mcp registration reap tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return noStore({ ok: false, error: "reap_failed" }, 500);
  }
}
