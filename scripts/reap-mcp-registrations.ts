import "dotenv/config";
import { pgPool } from "@/db/database";
import { getServerEnv } from "@/lib/env";
import { expireStalePendingMcpRegistrations } from "@/lib/mcp/reaper.server";

/**
 * MCP self-registration reaper (review #13, #51). Expires self-registered
 * agents that are still `pending_approval` after
 * MCP_REGISTRATION_PENDING_TTL_DAYS (default 7; 0 disables) — the non-Vercel
 * counterpart of `GET /api/internal/mcp-registration-reap`. Designed to run on
 * a schedule — a cron job, a Kubernetes CronJob, or any periodic init task:
 *
 *   pnpm mcp:reap        # one pass; safe to run concurrently (row predicates)
 *
 * Exits non-zero only on an unexpected error.
 */
async function main(): Promise<void> {
  const result = await expireStalePendingMcpRegistrations(
    getServerEnv().MCP_REGISTRATION_PENDING_TTL_DAYS,
  );
  console.log(`[mcp-reap] ttlDays=${result.ttlDays} expired=${result.expired}`);
}

main()
  .catch((err) => {
    console.error("[mcp-reap] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end();
  });
