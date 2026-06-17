import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { requiresSuperadminForSharedTarget, type OrgScope } from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { banBetterAuthUser, unbanBetterAuthUser } from "@/lib/admin/auth-admin.server";
import { performAdminStatusChange } from "@/lib/admin-status.server";

/**
 * Shared per-user mutation helpers used by both the per-id endpoints
 * (`/api/administrator/users/[id]/...`) and the bulk endpoint
 * (`/api/administrator/users/bulk`).
 *
 * Centralising these means the bulk path always emits the same audit
 * events and Better Auth side-effects as the single-row path — no
 * silent divergence between the two. Each helper resolves to a
 * structured `{ ok, error? }` so the bulk loop can aggregate
 * per-row outcomes without exception bubbling.
 */
export type BulkUserAction =
  | "approve"
  | "block"
  | "suspend"
  | "reactivate"
  | "ban"
  | "unban"
  | "soft_delete"
  | "restore";

export interface BulkUserActor {
  betterAuthUserId: string;
  request: { headers: Headers };
  /**
   * The actor's tenant scope (AUTHZ-1/2). Status actions are confined to this
   * org for an org admin; account-global actions (ban/unban, soft-delete/
   * restore) on a user shared with other orgs are refused unless SUPERADMIN.
   */
  scope: OrgScope;
}

/**
 * Per-row guard for the account-global bulk actions (ban/unban/soft-delete/
 * restore): a non-SUPERADMIN may not act account-globally on a user shared
 * with other orgs (AUTHZ-2). Returns the refusal outcome, or null when allowed.
 */
async function refuseSharedAccountGlobal(
  target: BulkUserTarget,
  actor: BulkUserActor,
): Promise<BulkUserOutcome | null> {
  if (await requiresSuperadminForSharedTarget(actor.scope, target.appUserId)) {
    return { ok: false, appUserId: target.appUserId, error: "forbidden_shared_target" };
  }
  return null;
}

export interface BulkUserTarget {
  appUserId: string;
  betterAuthUserId: string;
  primaryEmail: string;
  status: string;
}

export interface BulkUserOptions {
  /** Required for `ban`. Required by `soft_delete` only when provided. */
  reason?: string;
  /** Optional ban duration in seconds; omitted = indefinite. */
  expiresInSeconds?: number;
}

export type BulkUserOutcome =
  | { ok: true; appUserId: string }
  | { ok: false; appUserId: string; error: string };

const STATUS_ACTION_MAP: Partial<
  Record<
    BulkUserAction,
    {
      newStatus: "active" | "blocked" | "suspended";
      newMembershipStatus: "active" | "blocked" | "suspended";
      eventType: string;
    }
  >
> = {
  approve: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventType: "admin.user.approved",
  },
  block: {
    newStatus: "blocked",
    newMembershipStatus: "blocked",
    eventType: "admin.user.blocked",
  },
  suspend: {
    newStatus: "suspended",
    newMembershipStatus: "suspended",
    eventType: "admin.user.suspended",
  },
  reactivate: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventType: "admin.user.reactivated",
  },
};

async function performStatusAction(
  action: "approve" | "block" | "suspend" | "reactivate",
  target: BulkUserTarget,
  actor: BulkUserActor,
  options: BulkUserOptions,
): Promise<BulkUserOutcome> {
  const mapping = STATUS_ACTION_MAP[action];
  if (!mapping) return { ok: false, appUserId: target.appUserId, error: "invalid_action" };

  // The bulk endpoint has already authenticated the actor and checked
  // the action's permission; the core mutation is called once per row
  // without re-resolving the session. Headers are forwarded so the
  // audit row records the original IP / UA.
  const result = await performAdminStatusChange({
    actorBetterAuthUserId: actor.betterAuthUserId,
    scope: actor.scope,
    request: actor.request,
    targetAppUserId: target.appUserId,
    reason: options.reason,
    newStatus: mapping.newStatus,
    newMembershipStatus: mapping.newMembershipStatus,
    eventType: mapping.eventType,
  });

  if (result.ok) {
    return { ok: true, appUserId: target.appUserId };
  }
  return { ok: false, appUserId: target.appUserId, error: result.error };
}

async function performBan(
  target: BulkUserTarget,
  actor: BulkUserActor,
  options: BulkUserOptions,
): Promise<BulkUserOutcome> {
  if (!options.reason) {
    return { ok: false, appUserId: target.appUserId, error: "reason_required" };
  }
  const refused = await refuseSharedAccountGlobal(target, actor);
  if (refused) return refused;
  try {
    await banBetterAuthUser(
      {
        userId: target.betterAuthUserId,
        banReason: options.reason,
        banExpiresIn: options.expiresInSeconds,
      },
      actor.request,
    );
  } catch (err) {
    await auditUserAction("admin.user.ban_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_ban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "auth_ban_failed" };
  }
  await auditUserAction("admin.user.banned", "success", {
    request: actor.request,
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    reason: options.reason,
    metadata: { expiresInSeconds: options.expiresInSeconds ?? null, bulk: true },
  });
  return { ok: true, appUserId: target.appUserId };
}

async function performUnban(
  target: BulkUserTarget,
  actor: BulkUserActor,
): Promise<BulkUserOutcome> {
  const refused = await refuseSharedAccountGlobal(target, actor);
  if (refused) return refused;
  try {
    await unbanBetterAuthUser(target.betterAuthUserId, actor.request);
  } catch (err) {
    await auditUserAction("admin.user.unban_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_unban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "auth_unban_failed" };
  }
  await auditUserAction("admin.user.unbanned", "success", {
    request: actor.request,
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    metadata: { bulk: true },
  });
  return { ok: true, appUserId: target.appUserId };
}

async function performSoftDelete(
  target: BulkUserTarget,
  actor: BulkUserActor,
  options: BulkUserOptions,
): Promise<BulkUserOutcome> {
  const refused = await refuseSharedAccountGlobal(target, actor);
  if (refused) return refused;
  const reason = options.reason ?? null;
  try {
    await banBetterAuthUser(
      {
        userId: target.betterAuthUserId,
        banReason: reason ?? "deleted",
      },
      actor.request,
    );
  } catch (err) {
    await auditUserAction("admin.user.soft_delete_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_ban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "auth_ban_failed" };
  }

  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("app_users")
        .set({
          status: "deactivated",
          status_reason: reason,
          deactivated_at: sql`now()`,
          deactivated_by: actor.betterAuthUserId,
          deactivated_reason: reason,
          updated_at: sql`now()`,
        })
        .where("id", "=", target.appUserId)
        .execute();
      await trx
        .updateTable("app_organization_memberships")
        .set({
          // Snapshot prior status so `restore` can reverse the cascade
          // (plan §4.1). `where status != 'blocked'` keeps double-deletes
          // from clobbering the snapshot with the cascaded value.
          pre_deactivation_status: sql`status`,
          status: "blocked",
          updated_at: sql`now()`,
        })
        .where("app_user_id", "=", target.appUserId)
        .where("status", "!=", "blocked")
        .execute();
    });
  } catch (err) {
    // Compensate the Better Auth ban so the two systems stay in sync
    // when the application bookkeeping fails (#B6).
    try {
      await unbanBetterAuthUser(target.betterAuthUserId, actor.request);
    } catch (unbanErr) {
      await auditUserAction("admin.user.soft_delete_compensation_failed", "error", {
        request: actor.request,
        actorBetterAuthUserId: actor.betterAuthUserId,
        appUserId: target.appUserId,
        email: target.primaryEmail,
        reason: "compensation_unban_failed",
        metadata: {
          message: unbanErr instanceof Error ? unbanErr.message : "unknown",
          bulk: true,
        },
      });
    }
    await auditUserAction("admin.user.soft_delete_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "db_cascade_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "db_cascade_failed" };
  }

  await auditUserAction("admin.user.soft_deleted", "success", {
    request: actor.request,
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    reason,
    metadata: { bulk: true },
  });
  return { ok: true, appUserId: target.appUserId };
}

async function performRestore(
  target: BulkUserTarget,
  actor: BulkUserActor,
): Promise<BulkUserOutcome> {
  const refused = await refuseSharedAccountGlobal(target, actor);
  if (refused) return refused;
  try {
    await unbanBetterAuthUser(target.betterAuthUserId, actor.request);
  } catch (err) {
    await auditUserAction("admin.user.restore_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_unban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "auth_unban_failed" };
  }
  // Reverse the cascade applied by performSoftDelete: any membership
  // that still carries a `pre_deactivation_status` snapshot is
  // returned to that prior status, then the snapshot column cleared.
  // Memberships without a snapshot were either never cascaded or
  // already reversed — leave them alone.
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("app_users")
      .set({
        status: "pending_approval",
        status_reason: null,
        deactivated_at: null,
        deactivated_by: null,
        deactivated_reason: null,
        updated_at: sql`now()`,
      })
      .where("id", "=", target.appUserId)
      .execute();
    await trx
      .updateTable("app_organization_memberships")
      .set({
        status: sql`coalesce(pre_deactivation_status, status)`,
        pre_deactivation_status: null,
        updated_at: sql`now()`,
      })
      .where("app_user_id", "=", target.appUserId)
      .where("pre_deactivation_status", "is not", null)
      .execute();
  });
  await auditUserAction("admin.user.restored", "success", {
    request: actor.request,
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    metadata: { bulk: true },
  });
  return { ok: true, appUserId: target.appUserId };
}

/**
 * Dispatches one of the per-user bulk actions against a single
 * resolved target. The bulk endpoint loops over this helper so each
 * row gets its own audit row and one row's failure does not abort
 * the rest of the batch.
 */
export async function executeBulkUserAction(
  action: BulkUserAction,
  target: BulkUserTarget,
  actor: BulkUserActor,
  options: BulkUserOptions = {},
): Promise<BulkUserOutcome> {
  switch (action) {
    case "approve":
    case "block":
    case "suspend":
    case "reactivate":
      return performStatusAction(action, target, actor, options);
    case "ban":
      return performBan(target, actor, options);
    case "unban":
      return performUnban(target, actor);
    case "soft_delete":
      return performSoftDelete(target, actor, options);
    case "restore":
      return performRestore(target, actor);
    default: {
      // Exhaustive — TypeScript will flag a new variant added without
      // a case here.
      const exhaustive: never = action;
      return {
        ok: false,
        appUserId: target.appUserId,
        error: `unknown_action_${String(exhaustive)}`,
      };
    }
  }
}

/**
 * Maps a {@link BulkUserAction} to the permission required to invoke
 * it. Every member of {@link BulkUserAction} MUST have an entry here;
 * the bulk endpoint relies on this lookup to choose the right gate.
 */
export const BULK_USER_ACTION_PERMISSIONS: Record<BulkUserAction, string> = {
  approve: "admin.users.manage",
  block: "admin.users.manage",
  suspend: "admin.users.manage",
  reactivate: "admin.users.manage",
  ban: "admin.users.ban",
  unban: "admin.users.ban",
  soft_delete: "admin.users.delete",
  restore: "admin.users.delete",
};
