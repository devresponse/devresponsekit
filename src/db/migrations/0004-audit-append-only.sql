-- 0004-audit-append-only.sql
--
-- Forward migration (see run-migrations.ts; 0001 is frozen). Append-only and
-- idempotent.
--
-- B3: make app_audit_events tamper-evident. The audit log is a compliance
-- record, so the application database role must not be able to silently UPDATE
-- or DELETE rows. A row-level BEFORE trigger raises on any UPDATE/DELETE,
-- enforcing append-only semantics at the database — independent of any
-- application-layer discipline.
--
-- The ONE sanctioned exception is the D3 retention job
-- (src/lib/retention.server.ts), which sets `app.audit_retention = 'on'` (via
-- SET LOCAL, transaction-scoped) immediately before pruning rows older than the
-- retention window. So aged rows can still be reaped, but only by that explicit
-- path — a stray UPDATE or an ad-hoc DELETE is rejected. INSERTs are unaffected.
-- The two changes are order-independent: until this trigger exists, the D3 flag
-- is a harmless no-op.

create or replace function app_audit_events_block_mutation()
  returns trigger
  language plpgsql
as $$
begin
  -- Sanctioned retention deletes opt in via a transaction-local GUC. The
  -- `true` makes current_setting return NULL (not error) when it is unset.
  if tg_op = 'DELETE' and current_setting('app.audit_retention', true) = 'on' then
    return old;
  end if;
  raise exception 'app_audit_events is append-only: % is not permitted', tg_op
    using errcode = 'check_violation',
          hint = 'Audit rows are immutable; aged rows are removed only by the retention job.';
end;
$$;

drop trigger if exists trg_app_audit_events_append_only on app_audit_events;
create trigger trg_app_audit_events_append_only
  before update or delete on app_audit_events
  for each row
  execute function app_audit_events_block_mutation();
