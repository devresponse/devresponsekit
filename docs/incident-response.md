# Incident response runbook

_Audience: on-call engineers. How to triage, mitigate, and close out a production
incident with the signals this app actually emits. Pairs with
[observability.md](./observability.md) (what the signals are) and
[troubleshooting.md](./troubleshooting.md) (setup/build/runtime failures)._

---

## 1. Severity

| Sev | Meaning | Examples |
| --- | --- | --- |
| **SEV1** | Hard outage / data-integrity / security breach | App down, database unreachable, auth bypass, cross-tenant leak, secret exposure. |
| **SEV2** | Major degradation, no full outage | Elevated 5xx, sign-in failing for many, email not delivering, a deploy that broke a workspace. |
| **SEV3** | Minor / contained | One endpoint erroring, a single tenant affected, abuse from one actor. |

Declare the highest plausible severity first; downgrade once scoped. SEV1/SEV2
warrant a comms channel and an owner before deep debugging.

## 2. First five minutes

1. **Liveness / readiness.** `GET /api/health` → `200 {"status":"ok"}` means the
   process is up. `GET /api/health/ready` → `200 {"status":"ready"}` means it can
   reach the database; `503 {"status":"unavailable"}` means it cannot. These are
   unauthenticated and `no-store`, so a curl from anywhere works.
2. **Get a correlation id.** Reproduce the failure (or grab one from a user
   report) and capture the `x-request-id` response header. It is the join key
   across logs, audit rows, and Sentry — see [observability.md §4](./observability.md).
3. **Scope the blast radius.** One route, one tenant, one actor — or everything?
   The audit table and the log stream answer this fast (queries below).
4. **Recent change?** Check the last deploy and the last migration. Most SEV1/2
   incidents correlate with a release.

## 3. Triage by signal

- **Logs (structured, stdout):** grep the log stream for the `x-request-id` to
  get the server-side stack + fields. Redaction is automatic (no secrets in logs).
- **`app_audit_events`:** the durable record of security-relevant actions.
  ```sql
  -- everything tied to one request
  select created_at, event_type, outcome, actor_better_auth_user_id,
         organization_id, reason, ip_address
  from app_audit_events where request_id = '<x-request-id>' order by created_at;

  -- recent failures/denials, newest first
  select created_at, event_type, outcome, reason, ip_address
  from app_audit_events
  where outcome in ('error','failure','denied') and created_at > now() - interval '1 hour'
  order by created_at desc limit 200;
  ```
- **Sentry (if `NEXT_PUBLIC_SENTRY_DSN` is set):** the same `x-request-id` is a
  tag; events are scrubbed before they leave the app.
- **`app_outbox`:** email delivery state (`pending` / `sent` / `failed` / `logged`).

## 4. Playbooks

### Database unreachable (`/api/health/ready` → 503)
- Confirm the DB is up and reachable from the app's network/region.
- On serverless: a `503` storm under load usually means **connection exhaustion** —
  verify `DATABASE_URL` points at a **pooled** endpoint and `PGPOOL_MAX` is low
  (2–5). See [deployment.md §4](./deployment.md).
- A single stuck statement can no longer pin a connection: `statement_timeout`
  and `idle_in_transaction_session_timeout` are set on the pool. Look for the
  query that's timing out in the logs.
- Mitigation: scale the DB / pooler, or roll back a migration that changed a hot
  query plan.

### Elevated 5xx
- Every uncaught 5xx is logged (`onRequestError` → `logServerError`) and, if
  enabled, sent to Sentry — both stamped with the `x-request-id`. Pull a few,
  find the common stack.
- If it started at a deploy, **roll back first, debug second** (§5).

### Sign-in failing for many
- Check `app_audit_events` for `auth.signin.failure` clusters and reasons.
- Common causes: `BETTER_AUTH_URL` not matching the public origin (cookies
  rejected), a rotated `BETTER_AUTH_SECRET` (invalidates all sessions — expected
  after rotation), or the DB being unreachable.

### Email not delivering
- `select status, count(*) from app_outbox group by status;` — `failed` rows
  carry a short sanitized `error`. `logged` means no `EMAIL_PROVIDER` is set
  (expected in dev).
- On serverless, retries depend on the cron hitting `/api/internal/outbox-drain`
  (gated by `CRON_SECRET`) — confirm the cron is running and the secret is set.

### Abuse / rate-limit storm
- Rate-limit denials return `429` + `Retry-After` and are recorded (flood-safely,
  ≈1/min/actor) as `administrator.rate_limited` (outcome `denied`) in the audit
  log — query by `actor_better_auth_user_id` / `ip_address` to find the source.
- The limiter is in-memory per instance (single-instance is the supported 1.0
  topology); a process restart resets buckets. For a hard cluster-wide limit,
  see the post-1.0 roadmap in [deployment.md §4](./deployment.md).
- CSP violations report to `/api/security/csp-report` (rate-limited + aggregated);
  a spike there can indicate an injection attempt or a broken third-party asset.

### Suspected security incident (auth bypass / cross-tenant / secret exposure)
- Treat as **SEV1**. Preserve evidence — do **not** truncate `app_audit_events`
  (it is append-only). Capture the relevant `request_id`s and IPs.
- If a secret may be exposed, rotate it (`BETTER_AUTH_SECRET`,
  `SSO_HANDOFF_JWT_SECRET`, `API_JWT_PRIVATE_KEY`, provider keys) — rotating the
  auth secret signs everyone out, which is acceptable under a breach.
- Follow the private disclosure process in [SECURITY.md](../SECURITY.md).

## 5. Rollback

Migrations are additive / backward-compatible by contract, so the **previous
build is safe to re-promote against the current schema**.

- **Vercel:** promote the last-known-good deployment (Vercel dashboard → previous
  deployment → "Promote to Production", or `vercel rollback`). The deploy
  pipeline ([deployment.md §6](./deployment.md)) runs migrations *before*
  promotion, so a rollback does not need a DB change.
- **Container:** redeploy the previous image tag (the runtime image is
  digest-pinned; keep the prior tag available).
- A migration that genuinely must be reverted is a separate forward migration —
  never edit an applied one.

## 6. After the incident

- Confirm recovery against the §8 checklist in [deployment.md](./deployment.md)
  (health, auth, a DB-backed admin list, an audit row with a matching
  `x-request-id`).
- The audit log + the correlated `x-request-id`s are the post-incident record;
  write the timeline from them.
- File follow-ups for any missing signal — if triage was slow because a metric or
  trace didn't exist, that gap is itself an action item (the metrics/tracing
  roadmap is tracked in [observability.md §5](./observability.md)).

---

_Next: [Observability](./observability.md) · [Troubleshooting](./troubleshooting.md) · [Deployment](./deployment.md)_
