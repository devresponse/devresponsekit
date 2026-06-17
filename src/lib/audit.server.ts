import "server-only";
import type { NextRequest } from "next/server";
import { db } from "@/db/database";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
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
 */
export async function auditEvent(input: AuditEventInput): Promise<void> {
  const reqHeaders = input.request?.headers;
  const ipForwarded = reqHeaders?.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = reqHeaders?.get("user-agent") ?? null;
  const requestId = input.requestId ?? (input.request ? getOrCreateRequestId(input.request) : null);

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
      metadata: input.metadata,
    });
  }

  await db
    .insertInto("app_audit_events")
    .values({
      event_type: input.eventType,
      outcome: input.outcome,
      actor_better_auth_user_id: input.actorBetterAuthUserId ?? null,
      app_user_id: input.appUserId ?? null,
      organization_id: input.organizationId ?? null,
      target_application_id: input.targetApplicationId ?? null,
      provider: input.provider ?? null,
      email: input.email ?? null,
      ip_address: ipForwarded,
      user_agent: userAgent,
      reason: input.reason ?? null,
      request_id: requestId,
      metadata: JSON.stringify(input.metadata ?? {}),
    })
    .execute();
}
