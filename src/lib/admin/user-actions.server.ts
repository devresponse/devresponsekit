import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  banBetterAuthUser,
  unbanBetterAuthUser,
} from "@/lib/admin/auth-admin.server";
import { applyAdminStatusAction } from "@/lib/admin-status.server";

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
      eventOverride: string;
    }
  >
> = {
  approve: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventOverride: "admin.user.approved",
  },
  block: {
    newStatus: "blocked",
    newMembershipStatus: "blocked",
    eventOverride: "admin.user.blocked",
  },
  suspend: {
    newStatus: "suspended",
    newMembershipStatus: "suspended",
    eventOverride: "admin.user.suspended",
  },
  reactivate: {
    newStatus: "active",
    newMembershipStatus: "active",
    eventOverride: "admin.user.reactivated",
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

  // applyAdminStatusAction reads its body from the request, so we
  // synthesize a request with the per-row body. Headers are reused so
  // the audit row records the original IP / UA.
  const proxiedRequest = new Request("http://internal/bulk", {
    method: "POST",
    headers: actor.request.headers,
    body: JSON.stringify({ appUserId: target.appUserId, reason: options.reason }),
  });

  const res = await applyAdminStatusAction({
    request: proxiedRequest as unknown as Parameters<typeof applyAdminStatusAction>[0]["request"],
    newStatus: mapping.newStatus,
    newMembershipStatus: mapping.newMembershipStatus,
    eventOverride: mapping.eventOverride,
  });

  if (res.status >= 200 && res.status < 300) {
    return { ok: true, appUserId: target.appUserId };
  }
  return { ok: false, appUserId: target.appUserId, error: `status_${res.status}` };
}

async function performBan(
  target: BulkUserTarget,
  actor: BulkUserActor,
  options: BulkUserOptions,
): Promise<BulkUserOutcome> {
  if (!options.reason) {
    return { ok: false, appUserId: target.appUserId, error: "reason_required" };
  }
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
    await auditUserAction("admin.user.ban_failed", "failure", {
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
  try {
    await unbanBetterAuthUser(target.betterAuthUserId, actor.request);
  } catch (err) {
    await auditUserAction("admin.user.unban_failed", "failure", {
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
    await auditUserAction("admin.user.soft_delete_failed", "failure", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_ban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "auth_ban_failed" };
  }

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
      .set({ status: "blocked", updated_at: sql`now()` })
      .where("app_user_id", "=", target.appUserId)
      .execute();
  });

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
  try {
    await unbanBetterAuthUser(target.betterAuthUserId, actor.request);
  } catch (err) {
    await auditUserAction("admin.user.restore_failed", "failure", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      reason: "auth_unban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "auth_unban_failed" };
  }
  await db
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
      return { ok: false, appUserId: target.appUserId, error: `unknown_action_${String(exhaustive)}` };
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
