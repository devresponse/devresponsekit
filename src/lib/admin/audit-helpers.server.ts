import "server-only";
import type { Kysely } from "kysely";
import type { NextRequest } from "next/server";
import type { AppDatabase } from "@/db/schema/app-schema";
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
 *   - F-32: `organizationId` is REQUIRED (`string | null`) on all three
 *     contexts, so every call site decides which tenant's auditors see the
 *     row (docs/admin-manager.md §12, "Organization stamp"). The rule: the
 *     resource's org when the action is on an org-owned row (a membership, a
 *     role, a group, a key); otherwise the org an org-confined actor acted in
 *     (`actingOrganizationId`); `null` only for a platform-level action.
 *     Every tenant-facing audit read filters on this column, so a row written
 *     without it is invisible to the org it happened in.
 */
export interface UserAuditContext {
  request: NextRequest | { headers: Headers };
  actorBetterAuthUserId: string;
  /**
   * The `app_users.id` the event is about — an FK, so it must name a row that
   * exists. F-30: pass `null` when there is none (a create that failed before
   * or while writing the row, a summary over many users) and carry what the
   * caller asked for in `email` / `metadata` instead. Required, so the choice
   * is explicit at every call site.
   */
  appUserId: string | null;
  /**
   * F-32: the tenant the action happened in. A user has no org of its own, so
   * this is the membership's org for a membership event, and otherwise
   * `actingOrganizationId(guard.access)`: the org-confined actor's org, `null`
   * for an unbound superadmin (a platform row, never its active-org cookie).
   */
  organizationId: string | null;
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
    organizationId: ctx.organizationId,
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
  /**
   * F-32: the role's own `organization_id` (`null` for a global role, and for
   * the platform-wide permission catalog). Required, like on
   * {@link UserAuditContext}.
   */
  organizationId: string | null;
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
    organizationId: ctx.organizationId,
    reason: ctx.reason ?? null,
    request: ctx.request,
    requestId: ctx.requestId ?? null,
    metadata: ctx.metadata,
  });
}

export interface OrgAuditContext {
  request: NextRequest | { headers: Headers };
  actorBetterAuthUserId: string;
  /**
   * F-32: the organization acted on (`null` only for a platform-level event
   * such as the platform sign-up defaults). Required, like on
   * {@link UserAuditContext}.
   */
  organizationId: string | null;
  appUserId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * DB-3: transaction handle for an org audit that must be written inside the
   * caller's transaction. Only the tenant DELETE needs it — an
   * `admin.organization.deleted` row names an org the same request is removing,
   * so it MUST be inserted before the delete, while its `organization_id` FK
   * still has a parent to point at. Every other org audit runs after its
   * mutation on the shared pool, which is the default.
   *
   * DB-4: passing a handle also means a ROLLBACK discards the row in silence,
   * which is correct only for a `success` row whose subject the same
   * transaction is deleting. Never pass one for a `denied` or `error` org audit
   * — that record has to survive the rollback. See
   * {@link AuditEventInput.executor} for the full rule.
   */
  executor?: Kysely<AppDatabase>;
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
    organizationId: ctx.organizationId,
    appUserId: ctx.appUserId ?? null,
    reason: ctx.reason ?? null,
    request: ctx.request,
    requestId: ctx.requestId ?? null,
    metadata: ctx.metadata,
    executor: ctx.executor,
  });
}
