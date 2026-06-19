-- 0003-outbox-retry.sql
--
-- Forward migration (see run-migrations.ts; 0001 is frozen). Append-only and
-- idempotent.
--
-- Gives app_outbox a retry lifecycle so transient delivery failures are
-- re-attempted instead of silently dropped (review D1). Statuses are unchanged
-- ('pending' | 'sent' | 'failed' | 'logged'): a still-retryable row stays
-- 'pending' with a future `next_attempt_at`; it only becomes terminal 'failed'
-- once `attempts` hits the worker's cap. The outbox drainer
-- (src/lib/email/outbox-worker.server.ts) claims due rows
-- (status='pending' AND next_attempt_at <= now) FOR UPDATE SKIP LOCKED.
alter table app_outbox add column if not exists attempts integer not null default 0;
alter table app_outbox add column if not exists next_attempt_at timestamptz;
alter table app_outbox add column if not exists last_attempt_at timestamptz;

-- Claim index for the drainer: due pending rows, oldest-scheduled first. Partial
-- on status so it stays small (sent/failed/logged rows are excluded).
create index if not exists idx_app_outbox_due
  on app_outbox (next_attempt_at)
  where status = 'pending';
