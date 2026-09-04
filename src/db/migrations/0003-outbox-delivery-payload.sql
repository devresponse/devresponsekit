-- 0003-outbox-delivery-payload.sql
--
-- Outbox secret redaction (review #21). `sendAppEmail` now stores a REDACTED
-- rendering in `app_outbox.subject` / `body_html` / `body_text` / `variables`
-- (reset / verification / invitation tokens replaced by `[redacted]`), because
-- those columns feed the org-scoped administrator outbox API. The retry worker
-- still needs the real message, so the unredacted rendering is kept here —
-- ONLY for rows whose body actually carried a secret — and is nulled the
-- moment the row reaches a terminal `sent` / `failed` state.
--
-- Contract: no administrator route ever selects this column. It is DB-only
-- (the same trust boundary as Better Auth's own `verification` table, which
-- already holds the reset token in plaintext). Rows written before this
-- migration have `delivery_payload` null and their stored body IS the
-- deliverable, so the worker falls back to `body_html` / `body_text`.
--
-- Idempotent: `add column if not exists`.

alter table app_outbox add column if not exists delivery_payload jsonb;
