import "dotenv/config";
import { drainOutbox } from "@/lib/email/outbox-worker.server";
import { pgPool } from "@/db/database";

/**
 * Outbox drainer (review D1). Re-attempts delivery of `app_outbox` rows left
 * RETRYABLE by a transient provider failure (status='pending' with a due
 * `next_attempt_at`). Designed to run on a schedule — a cron job, a Kubernetes
 * CronJob, or any periodic init task:
 *
 *   pnpm outbox:drain        # one pass; safe to run concurrently (SKIP LOCKED)
 *
 * Tune the per-run batch with OUTBOX_DRAIN_LIMIT (default 100). Exits non-zero
 * only on an unexpected error, not when rows merely fail and reschedule.
 */
async function main(): Promise<void> {
  const raw = Number.parseInt(process.env.OUTBOX_DRAIN_LIMIT ?? "100", 10);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : 100;
  const result = await drainOutbox(limit);
  console.log(
    `[outbox] claimed=${result.claimed} sent=${result.sent} retried=${result.retried} failed=${result.failed}`,
  );
}

main()
  .catch((err) => {
    console.error("[outbox] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end();
  });
