import "server-only";
import type { NextRequest } from "next/server";
import { db } from "@/db/database";

export interface AuditEventInput {
  eventType: string;
  outcome: "success" | "failure" | "denied";
  actorBetterAuthUserId?: string | null;
  appUserId?: string | null;
  organizationId?: string | null;
  targetApplicationId?: string | null;
  provider?: string | null;
  email?: string | null;
  reason?: string | null;
  request?: NextRequest | { headers: Headers };
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
      metadata: JSON.stringify(input.metadata ?? {}),
    })
    .execute();
}
