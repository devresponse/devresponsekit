import "server-only";
import type { Kysely } from "kysely";
import type { NextRequest } from "next/server";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { getClientIp } from "@/lib/client-ip";
import { attributeAuditActor } from "@/lib/impersonation-attribution.server";
import { logServerError } from "@/lib/observability/logger.server";

/**
 * Permitted audit outcomes (docs/admin-manager.md §12):
 *
 *   - `success` — the operation completed.
 *   - `denied`  — authorization (permission/membership/status) refused.
 *   - `error`   — an unexpected service failure (DB, Better Auth, IO).
 *   - `failure` — DEPRECATED legacy alias kept for back-compat with
 *                 historical SSO and pre-spec audit rows. New call
 *                 sites MUST use `error`.
 */
export type AuditOutcome = "success" | "denied" | "error" | "failure";

export interface AuditEventInput {
  eventType: string;
  outcome: AuditOutcome;
  /**
   * The principal the caller believes acted — usually `guard.betterAuthUserId`.
   * On an impersonated request this is the BORROWED identity, and the row is
   * re-attributed to the human behind the session (F-07); see
   * {@link auditEvent}.
   */
  actorBetterAuthUserId?: string | null;
  appUserId?: string | null;
  organizationId?: string | null;
  targetApplicationId?: string | null;
  provider?: string | null;
  email?: string | null;
  reason?: string | null;
  request?: NextRequest | { headers: Headers };
  /**
   * Optional pre-computed correlation id. When omitted we fall back to
   * the request's `x-request-id` header (or generate one).
   */
  requestId?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Write the row through THIS handle instead of the shared pool — i.e. inside
   * the caller's transaction. Per-call context like `request` / `requestId`
   * above, not part of the event itself. Defaults to the pool, which is what
   * every call site that audits AFTER its mutation wants.
   *
   * DB-3: the call sites that MUST pass one are the audits naming a row the
   * same request is about to delete. `organization_id` carries a real FK to
   * `app_organizations`; `ON DELETE SET NULL` rescues rows that ALREADY EXIST
   * when the parent goes away, but it says nothing about a NEW insert naming an
   * id that is already gone — that insert is a plain foreign-key violation.
   * Writing the row inside the deleting transaction, ahead of the delete, both
   * satisfies the FK and makes the audit atomic with the outcome it describes:
   * nothing is removed without its audit row, and a delete that rolls back
   * leaves no row claiming it happened.
   *
   * DB-4 — the inverse hazard, stated here because this is a public knob on a
   * primitive every route reaches: a row written through a transaction handle
   * is DISCARDED, silently and with no error raised anywhere, when that
   * transaction rolls back. For the DB-3 `success` row that is the point — it
   * must not outlive the outcome it claims. For a `denied` or an `error` row it
   * is exactly backwards: those are the rows the contract below refuses to
   * suppress, because a lost denial is an unrecorded attack, and the
   * OBSERVABILITY-2 stdout mirror is no safety net either (it fires for
   * `error`/`failure`, never for `denied`). So a caller that wraps a mutation in
   * a transaction MUST NOT thread the same handle into its failure audit out of
   * symmetry.
   *
   * The rule, in one line: pass `executor` ONLY for an audit that names a row
   * this very transaction is deleting, and therefore SHOULD vanish with it.
   * Every other audit — including every denial and failure raised inside a
   * transaction — belongs on the pool, written after the rollback, the way the
   * tenant DELETE writes its `admin.organization.delete_blocked` row.
   */
  executor?: Kysely<AppDatabase>;
}

/**
 * Writes a structured audit event.
 *
 * Threat / contract:
 *   - Audit logging is required for auth failures, SSO failures, status
 *     changes, and denied navigation. Suppressing failures here would
 *     hide attacks, so this function intentionally surfaces errors to
 *     the caller — log them but never include secrets in the metadata.
 *   - `metadata` is serialized as JSON. Callers MUST NOT pass tokens,
 *     refresh tokens, or raw passwords.
 *   - Impersonation (F-07): on a request whose session is an impersonation,
 *     a row naming the borrowed identity (or already the human) is written
 *     with `actor_better_auth_user_id` = the IMPERSONATING admin and
 *     `metadata.impersonatedBetterAuthUserId` = the borrowed identity, so the
 *     audit trail names who actually acted (docs/admin-manager.md §12). The
 *     request's session read records the impersonation
 *     (`impersonation-attribution.server.ts`); this reads it, so a row is
 *     attributed only when the caller passes `request`.
 *   - `input.executor` (DB-3) writes the row inside the caller's transaction,
 *     which also means a ROLLBACK discards it without raising anything — the
 *     one suppression path this function has. DB-4: that is mandatory for an
 *     audit naming a row the same transaction deletes, and FORBIDDEN for a
 *     `denied`/`error` audit, which must outlive the rollback for the reason
 *     in the bullet above. See the field's doc for the full rule.
 */
export async function auditEvent(input: AuditEventInput): Promise<void> {
  const reqHeaders = input.request?.headers;
  // Trusted-hop client IP (the P2-4 helper), NOT the attacker-controlled
  // leftmost X-Forwarded-For — so audit rows hold a forensically reliable
  // address even when a client spoofs the header.
  const ipAddress = reqHeaders ? getClientIp(reqHeaders) : null;
  const userAgent = reqHeaders?.get("user-agent") ?? null;
  const requestId = input.requestId ?? (input.request ? getOrCreateRequestId(input.request) : null);
  // F-07: a row written by an impersonated session names the HUMAN, with the
  // borrowed identity in `metadata.impersonatedBetterAuthUserId`. Decided here,
  // once, from what the request's session read recorded — not by each of the
  // hundred call sites that pass `guard.betterAuthUserId`, which on an
  // impersonated request is the target.
  const { actorBetterAuthUserId, metadata } = attributeAuditActor(input);

  // OBSERVABILITY-2: mirror unexpected failures to the structured stdout
  // logger so a no-Sentry deployment (the default) still has a correlated
  // error stream. Only `error`/`failure` (5xx-class) outcomes are logged —
  // `success`/`denied` live in the audit table only, keeping the error
  // stream signal-rich. `metadata` may carry an `err.message` but, per the
  // audit contract, never secrets.
  if (input.outcome === "error" || input.outcome === "failure") {
    logServerError(`audit.${input.eventType}`, {
      requestId,
      eventType: input.eventType,
      outcome: input.outcome,
      organizationId: input.organizationId ?? undefined,
      appUserId: input.appUserId ?? undefined,
      reason: input.reason ?? undefined,
      metadata,
    });
  }

  await (input.executor ?? db)
    .insertInto("app_audit_events")
    .values({
      event_type: input.eventType,
      outcome: input.outcome,
      actor_better_auth_user_id: actorBetterAuthUserId,
      app_user_id: input.appUserId ?? null,
      organization_id: input.organizationId ?? null,
      target_application_id: input.targetApplicationId ?? null,
      provider: input.provider ?? null,
      email: input.email ?? null,
      ip_address: ipAddress,
      user_agent: userAgent,
      reason: input.reason ?? null,
      request_id: requestId,
      metadata: JSON.stringify(metadata ?? {}),
    })
    .execute();
}
