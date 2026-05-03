-- 0003-audit-request-id-and-membership-snapshot.sql
--
-- Production-hardening migration (docs/admin-manager.md §12 + §4.1):
--
--   1. Add `app_audit_events.request_id` so every audit row can be
--      joined to the originating request via the `x-request-id`
--      response header. NULL for historical rows written before this
--      migration; new rows always carry a value.
--
--   2. Add `app_organization_memberships.pre_deactivation_status` so
--      the soft-delete cascade can capture each membership's prior
--      status before forcing it to `blocked`, and the matching
--      `restore` endpoint can return memberships to that prior status
--      instead of leaving them inaccessible. NULL outside the
--      soft-delete lifecycle.
--
-- Idempotent: every statement uses `add column if not exists`.

alter table app_audit_events
  add column if not exists request_id text;

create index if not exists idx_app_audit_events_request_id
  on app_audit_events (request_id)
  where request_id is not null;

alter table app_organization_memberships
  add column if not exists pre_deactivation_status text;
