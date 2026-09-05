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
 * Windows are AUDIT_RETENTION_DAYS (default 365), OUTBOX_RETENTION_DAYS
 * (default 90, terminal outbox rows) and OUTBOX_MAX_PENDING_DAYS (default 7:
 * `pending` rows older than this are marked `failed` — reported as
 * `staleOutboxFailed` — so orphans queued for a since-removed provider become
 * prunable); set any of them to 0 to disable that prune / sweep. Defaults and
 * semantics mirror `src/lib/retention.server.ts`. Exits non-zero only on an
 * unexpected error.
 */
async function main(): Promise<void> {
  const result = await pruneAll();
  console.log(
    `[retention] revocations=${result.revocations} audit=${result.auditEvents} outbox=${result.outbox} staleOutboxFailed=${result.staleOutboxFailed}`,
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
