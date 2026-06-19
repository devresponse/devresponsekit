import "dotenv/config";
import { pruneAll } from "@/lib/retention.server";
import { pgPool } from "@/db/database";

/**
 * Data-retention pruner (review D3). Prunes expired token revocations and
 * applies the configured retention windows to `app_audit_events` and
 * `app_outbox`. Designed to run on a schedule — a cron job, a Kubernetes
 * CronJob, or any periodic init task:
 *
 *   pnpm db:prune        # one pass
 *
 * Windows are AUDIT_RETENTION_DAYS (default 365) and OUTBOX_RETENTION_DAYS
 * (default 90); set either to 0 to disable that table's time-based prune.
 * Exits non-zero only on an unexpected error.
 */
async function main(): Promise<void> {
  const result = await pruneAll();
  console.log(
    `[retention] revocations=${result.revocations} audit=${result.auditEvents} outbox=${result.outbox}`,
  );
}

main()
  .catch((err) => {
    console.error("[retention] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end();
  });
