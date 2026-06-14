-- ---------------------------------------------------------------------------
-- 0002 — Add the tenant dimension to app_outbox (ADR-0001).
--
-- The outbox is the operator's record of every outbound email. Without an
-- organization column it could only be read by SUPERADMIN, because a row
-- exposes a recipient address that belongs to some tenant. Adding the
-- column lets an ORG ADMIN read their own org's outbound mail while
-- platform/system mail (organization_id IS NULL) stays SUPERADMIN-only.
--
-- Idempotent and safe to re-run: `add column if not exists` +
-- `create index if not exists`. Fresh databases already get the column
-- from 0001-initial-schema.sql, so this is a no-op there.
--
-- Backfill: existing rows are intentionally left NULL. We cannot reliably
-- attribute historical mail to a single org after the fact, and NULL is the
-- safe default (SUPERADMIN-only). New mail is attributed at send time.
-- ---------------------------------------------------------------------------

alter table app_outbox
  add column if not exists organization_id uuid
  references app_organizations (id) on delete set null;

create index if not exists idx_app_outbox_organization_id
  on app_outbox (organization_id);
