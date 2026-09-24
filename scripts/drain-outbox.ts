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
 *
 * This is its own process, so the `devresponsekit_outbox_delivery_total`
 * increments the worker makes here die with it and never reach the server's
 * `/api/metrics` (F-27). What an operator gets from a run is the per-row
 * `email_delivery` log lines and the summary below; `expired` (counted inside
 * `failed` too) is broken out because only the worker produces it. See
 * observability.md §5.
 */
async function main(): Promise<void> {
  const raw = Number.parseInt(process.env.OUTBOX_DRAIN_LIMIT ?? "100", 10);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : 100;
  const result = await drainOutbox(limit);
  console.log(
    `[outbox] claimed=${result.claimed} sent=${result.sent} retried=${result.retried} failed=${result.failed} expired=${result.expired}`,
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
