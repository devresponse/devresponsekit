import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  requiresSuperadminForSharedTarget,
  membershipCascadeStripsLastGlobalSuperuser,
  LastSuperadminCascadeError,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_EVENT,
  LAST_SUPERADMIN_REASON,
  type AccessLike,
  type OrgScope,
} from "@/lib/admin/access-scope.server";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { banBetterAuthUser, unbanBetterAuthUser } from "@/lib/admin/auth-admin.server";
import { targetOutranksActor } from "@/lib/admin/user-target.server";
import { performAdminStatusChange } from "@/lib/admin-status.server";
import { humanActorId } from "@/lib/impersonation-attribution.server";

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
  "approve" | "block" | "suspend" | "reactivate" | "ban" | "unban" | "soft_delete" | "restore";

export interface BulkUserActor {
  betterAuthUserId: string;
  /**
   * The impersonating admin when the batch runs on an impersonated session
   * (`guard.impersonatorId`). Written to `deactivated_by` in its place, so the
   * column names the human who acted (F-07). The per-row audit rows need no
   * help: `auditEvent` attributes them from `request`.
   */
  impersonatorId?: string | null;
  request: { headers: Headers };
  /**
   * The actor's tenant scope (AUTHZ-1/2). Status actions are confined to this
   * org for an org admin; account-global actions (ban/unban, soft-delete/
   * restore) on a user shared with other orgs are refused unless SUPERADMIN.
   */
  scope: OrgScope;
  /**
   * The actor's access context (permissions + org + the MACHINE-2 `orgBound`
   * marker), used by the per-row privilege-ordering guard (review #7): a
   * non-SUPERADMIN may not act on a target who outranks them, and an org-bound
   * credential may not act on a global superuser at all. Pass `guard.access`.
   *
   * Declared as the shared `AccessLike` slice rather than a local `Pick` so a
   * future refactor cannot type `orgBound` away on the way in — `orgBound` is
   * optional, so a narrower Pick would still compile while silently stripping
   * the marker this guard now reads.
   */
  access: AccessLike;
  /**
   * Correlation id of the batch request (`guard.requestId`), stamped on the
   * per-row refusal audit rows so a denied row can be joined to the
   * `x-request-id` of the bulk call. Optional for legacy callers.
   */
  requestId?: string;
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
  { ok: true; appUserId: string } | { ok: false; appUserId: string; error: string };

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
  // REVOKE-2 (review #444): `block` / `suspend` reach the last-superadmin guard
  // inside `performAdminStatusChange`, which audits the denial and returns
  // `last_superadmin`. Surfacing `result.error` verbatim (as this helper always
  // has) is what keeps the bulk path from being a way around the single-row
  // 409 — the row simply fails and the rest of the batch proceeds.
  return { ok: false, appUserId: target.appUserId, error: result.error };
}

/**
 * REVOKE-2 scope note (review #444): `ban` / `unban` are deliberately NOT gated
 * by the last-superadmin invariant. That invariant is defined on ROWS — an
 * active membership plus an assignment of a role carrying `superuser` — and a
 * ban touches none of them: the grant survives intact, `userIsGlobalSuperuser`
 * still reports the target, and `unban` restores access without re-conferring
 * anything. Banning the last superadmin does lock them out of the UI, so it is
 * a real (if reversible-by-row-edit) lockout; gating it needs a different
 * predicate — "at least one superadmin can still SIGN IN", which would also
 * have to read `app_users.status` and the Better Auth ban flags — and that is a
 * separate change, recorded as such in docs/admin-manager.md §8.1 rather than
 * implied closed here.
 */
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
      // REVOKE-2 (review #444): identical to the `[id]` route's soft-delete —
      // the cascade below blocks every membership the target holds, which is
      // how a `superuser` assignment stops counting. The bulk path must refuse
      // it for the same reason and by the same predicate, or `POST /users/bulk`
      // would be the way around the single-row 409.
      if (await membershipCascadeStripsLastGlobalSuperuser(target.appUserId, trx)) {
        throw new LastSuperadminCascadeError();
      }

      await trx
        .updateTable("app_users")
        .set({
          status: "deactivated",
          status_reason: reason,
          deactivated_at: sql`now()`,
          deactivated_by: humanActorId(actor),
          deactivated_reason: reason,
          updated_at: sql`now()`,
        })
        .where("id", "=", target.appUserId)
        .execute();
      await trx
        .updateTable("app_organization_memberships")
        .set({
          // Snapshot prior status so `restore` can reverse the cascade
          // (docs/admin-manager.md §8.1). `where status != 'blocked'` keeps
          // double-deletes from clobbering the snapshot with the cascaded value.
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
    // REVOKE-2: an expected per-row refusal, not a fault. The transaction rolled
    // back and the ban was compensated above, so the row is untouched — report
    // it with the shared code the single-row route answers 409 with, so the
    // console can tell "refused to strip the last superadmin" apart from "the
    // cascade blew up".
    if (err instanceof LastSuperadminCascadeError) {
      await auditUserAction(LAST_SUPERADMIN_EVENT, "denied", {
        request: actor.request,
        actorBetterAuthUserId: actor.betterAuthUserId,
        appUserId: target.appUserId,
        email: target.primaryEmail,
        requestId: actor.requestId ?? null,
        reason: LAST_SUPERADMIN_REASON,
        metadata: { action: "soft_delete", bulk: true },
      });
      return { ok: false, appUserId: target.appUserId, error: LAST_SUPERADMIN_ERROR };
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
  // Privilege ordering (review #7): every bulk action is a lockout / status
  // primitive, so — exactly like the single-row routes — a non-SUPERADMIN may
  // not apply it to a target who outranks them (a single-org superadmin, or a
  // more-privileged peer). Refused rows are audited and reported per row so
  // the batch cannot be used to bypass the `[id]` route guard.
  if (await targetOutranksActor(actor.access, target)) {
    await auditUserAction("admin.user.action_denied", "denied", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      requestId: actor.requestId ?? null,
      reason: "target_outranks_actor",
      metadata: { action, targetBetterAuthUserId: target.betterAuthUserId, bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "forbidden_target_outranks_actor" };
  }
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
