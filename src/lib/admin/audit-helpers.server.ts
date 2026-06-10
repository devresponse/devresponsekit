import "server-only";
import type { NextRequest } from "next/server";
import { auditEvent, type AuditEventInput } from "@/lib/audit.server";

/**
 * Per-area audit helpers for the Administrator workspace
 * (docs/admin-manager.md §5.3, §12). These are thin wrappers around
 * {@link auditEvent} that fix the most common fields per call-site so
 * route handlers stay declarative and consistent.
 *
 * Threat / contract:
 *   - Helpers do NOT swallow errors — `auditEvent` is awaited and
 *     surfaced. Callers MUST `await` these helpers.
 *   - `metadata` MUST NOT include secrets (passwords, tokens). The
 *     `auditEvent` JSDoc spells this out; these helpers preserve that
 *     contract by not transforming the metadata.
 *   - Pass `requestId` (typically from the `requireAdminPermission`
 *     grant) so every audit row written by a single request shares
 *     the same correlation id.
 */
export interface UserAuditContext {
  request: NextRequest | { headers: Headers };
  actorBetterAuthUserId: string;
  appUserId: string;
  email?: string | null;
  reason?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function auditUserAction(
  eventType: string,
  outcome: AuditEventInput["outcome"],
  ctx: UserAuditContext,
): Promise<void> {
  await auditEvent({
    eventType,
    outcome,
    actorBetterAuthUserId: ctx.actorBetterAuthUserId,
    appUserId: ctx.appUserId,
    email: ctx.email ?? null,
    reason: ctx.reason ?? null,
    request: ctx.request,
    requestId: ctx.requestId ?? null,
    metadata: ctx.metadata,
  });
}

export interface RoleAuditContext {
  request: NextRequest | { headers: Headers };
  actorBetterAuthUserId: string;
  organizationId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function auditRoleAction(
  eventType: string,
  outcome: AuditEventInput["outcome"],
  ctx: RoleAuditContext,
): Promise<void> {
  await auditEvent({
    eventType,
    outcome,
    actorBetterAuthUserId: ctx.actorBetterAuthUserId,
    organizationId: ctx.organizationId ?? null,
    reason: ctx.reason ?? null,
    request: ctx.request,
    requestId: ctx.requestId ?? null,
    metadata: ctx.metadata,
  });
}

export interface OrgAuditContext {
  request: NextRequest | { headers: Headers };
  actorBetterAuthUserId: string;
  organizationId?: string | null;
  appUserId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function auditOrgAction(
  eventType: string,
  outcome: AuditEventInput["outcome"],
  ctx: OrgAuditContext,
): Promise<void> {
  await auditEvent({
    eventType,
    outcome,
    actorBetterAuthUserId: ctx.actorBetterAuthUserId,
    organizationId: ctx.organizationId ?? null,
    appUserId: ctx.appUserId ?? null,
    reason: ctx.reason ?? null,
    request: ctx.request,
    requestId: ctx.requestId ?? null,
    metadata: ctx.metadata,
  });
}
