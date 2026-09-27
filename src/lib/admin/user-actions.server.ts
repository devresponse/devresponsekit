import "server-only";
import { sql, type Kysely } from "kysely";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import {
  requiresSuperadminForSharedTarget,
  scopeOrganizationId,
  banStripsLastGlobalSuperuser,
  LastSuperadminCascadeError,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_EVENT,
  LAST_SUPERADMIN_REASON,
  type AccessLike,
  type OrgScope,
} from "@/lib/admin/access-scope.server";
import { auditUserAction, type UserAuditContext } from "@/lib/admin/audit-helpers.server";
import {
  banBetterAuthUser,
  restoreBetterAuthBan,
  unbanBetterAuthUser,
  type BanSnapshot,
} from "@/lib/admin/auth-admin.server";
import { mustUseRestore, USE_RESTORE_ERROR } from "@/lib/admin/deactivated-user";
import { targetOutranksActor } from "@/lib/admin/user-target.server";
import { performAdminStatusChange } from "@/lib/admin-status.server";
import { revokeBearerCredentialsOf } from "@/lib/api-auth/credential-eviction.server";
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
  /**
   * The actor's `app_users` id (`guard.access.appUserId`), written to
   * `revoked_by` on the credentials a soft-delete revokes (I-19). Omitted or
   * `null` records the account itself, as `revokeBearerCredentialsOf` does.
   */
  appUserId?: string | null;
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

/** Outcome of {@link guardAppliedBan}. */
export type AppliedBanGuard =
  | { ok: true }
  | { ok: false; error: typeof LAST_SUPERADMIN_ERROR }
  | { ok: false; error: "revocation_check_failed"; cause: unknown };

/**
 * REVOKE-2 for a ban that `banBetterAuthUser` has JUST applied (F-56), shared
 * by `POST /users/[id]/ban` and the `ban` bulk action so both refuse, undo and
 * audit it identically.
 *
 * Before F-56 a ban was not gated at all: the invariant counted grants by their
 * rows, a ban changes none of them, so after banning a co-superadmin a
 * superadmin could block or demote themselves while the banned grant still
 * "survived". The invariant now counts only accounts that can sign in, and a
 * ban is measured as the loss of the target's whole account. The check has to
 * FOLLOW the ban (see `banStripsLastGlobalSuperuser`), so a refusal is a saga
 * like the soft-delete's: the ban is undone and the refusal audited here, and
 * the caller only answers it. A check that fails outright is undone the same
 * way, so a ban nobody could verify is never left in place. Undoing puts back
 * `previousBan`, the ban the new one replaced (`banBetterAuthUser`), rather
 * than lifting every ban (F-57).
 */
export async function guardAppliedBan(
  target: { appUserId: string; betterAuthUserId: string; primaryEmail: string },
  audit: Pick<UserAuditContext, "request" | "actorBetterAuthUserId" | "organizationId"> & {
    requestId?: string | null;
    bulk?: boolean;
  },
  previousBan: BanSnapshot | null,
): Promise<AppliedBanGuard> {
  let failure: { cause: unknown } | null = null;
  let stripsLast = false;
  try {
    stripsLast = await db.transaction().execute((trx) => banStripsLastGlobalSuperuser(target, trx));
  } catch (err) {
    failure = { cause: err };
  }
  if (!stripsLast && failure === null) return { ok: true };

  const bulk = audit.bulk ? { bulk: true } : {};
  // `organizationId` is named at each write, not spread from here (F-32).
  const context = {
    request: audit.request,
    actorBetterAuthUserId: audit.actorBetterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    requestId: audit.requestId ?? null,
  };
  try {
    await restoreBetterAuthBan(target.betterAuthUserId, previousBan);
  } catch (unbanErr) {
    await auditUserAction("admin.user.ban_compensation_failed", "error", {
      ...context,
      organizationId: audit.organizationId,
      reason: "compensation_unban_failed",
      metadata: { message: unbanErr instanceof Error ? unbanErr.message : "unknown", ...bulk },
    });
  }
  if (failure !== null) {
    await auditUserAction("admin.user.ban_failed", "error", {
      ...context,
      organizationId: audit.organizationId,
      reason: "revocation_check_failed",
      metadata: {
        message: failure.cause instanceof Error ? failure.cause.message : "unknown",
        ...bulk,
      },
    });
    return { ok: false, error: "revocation_check_failed", cause: failure.cause };
  }
  await auditUserAction(LAST_SUPERADMIN_EVENT, "denied", {
    ...context,
    organizationId: audit.organizationId,
    reason: LAST_SUPERADMIN_REASON,
    metadata: { action: "ban", ...bulk },
  });
  return { ok: false, error: LAST_SUPERADMIN_ERROR };
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
  let previousBan: BanSnapshot | null;
  try {
    ({ previousBan } = await banBetterAuthUser({
      userId: target.betterAuthUserId,
      banReason: options.reason,
      banExpiresIn: options.expiresInSeconds,
      actorBetterAuthUserId: actor.betterAuthUserId,
    }));
  } catch (err) {
    await auditUserAction("admin.user.ban_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: scopeOrganizationId(actor.scope),
      email: target.primaryEmail,
      reason: "auth_ban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "auth_ban_failed" };
  }
  // REVOKE-2 (F-56): the same guard as the single-row route, so the bulk path
  // is no way around its 409; the row fails and the batch goes on.
  const guarded = await guardAppliedBan(
    target,
    {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      organizationId: scopeOrganizationId(actor.scope),
      requestId: actor.requestId,
      bulk: true,
    },
    previousBan,
  );
  if (!guarded.ok) return { ok: false, appUserId: target.appUserId, error: guarded.error };
  await auditUserAction("admin.user.banned", "success", {
    request: actor.request,
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: scopeOrganizationId(actor.scope),
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
    await unbanBetterAuthUser(target.betterAuthUserId);
  } catch (err) {
    await auditUserAction("admin.user.unban_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: scopeOrganizationId(actor.scope),
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
    organizationId: scopeOrganizationId(actor.scope),
    email: target.primaryEmail,
    metadata: { bulk: true },
  });
  return { ok: true, appUserId: target.appUserId };
}

/*
 * F-57 — A SOFT-DELETE KEEPS AN EARLIER BAN, AND RESTORE PUTS IT BACK.
 *
 * A soft-delete bans the account indefinitely over whatever ban it already
 * had, and restore used to lift the ban outright. A user banned for abuse and
 * then soft-deleted came back from restore with no ban at all, so undoing a
 * delete (`admin.users.delete`) lifted a ban its holder may not lift
 * (`admin.users.ban`). The saga's own undo, after a failed or REVOKE-2-refused
 * cascade, erased the earlier ban the same way.
 *
 * So the ban a soft-delete replaced (reason and expiry) is recorded in
 * `metadata.priorBan` of its `admin.user.soft_deleted` row, and restore reads
 * the latest such row back and puts that ban in place again, or lifts the ban
 * when there was none or it has expired since (`restoreBetterAuthBan`). The
 * audit row is the record because it is append-only, already describes the
 * deletion, and needs no schema change; the impersonation stop reads its start
 * row the same way (F-32). Retention bounds it: once the row has been pruned
 * (`AUDIT_RETENTION_DAYS`, 365 days by default and never under 30), restore
 * lifts the ban as it used to. The saga undoes its own ban from the ban it
 * replaced, held in memory.
 */

/** The audit event of a completed soft-delete; restore reads its `metadata.priorBan`. */
export const SOFT_DELETED_EVENT = "admin.user.soft_deleted";

/** The ban as the soft-delete's audit metadata stores it. */
function banRecord(
  ban: BanSnapshot | null,
): { reason: string | null; expiresAt: string | null } | null {
  return ban ? { reason: ban.reason, expiresAt: ban.expiresAt?.toISOString() ?? null } : null;
}

/**
 * The ban the latest soft-delete of `appUserId` replaced, as its audit row
 * recorded it, or `null` (none, or no such row: a soft-delete from before
 * F-57, or one retention has pruned).
 */
export async function recordedPriorBan(appUserId: string): Promise<BanSnapshot | null> {
  const row = await db
    .selectFrom("app_audit_events")
    .select("metadata")
    .where("app_user_id", "=", appUserId)
    .where("event_type", "=", SOFT_DELETED_EVENT)
    .where("outcome", "=", "success")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const prior = (row?.metadata as { priorBan?: unknown } | undefined)?.priorBan;
  if (!prior || typeof prior !== "object") return null;
  const { reason, expiresAt } = prior as { reason?: unknown; expiresAt?: unknown };
  return {
    reason: typeof reason === "string" ? reason : null,
    expiresAt: typeof expiresAt === "string" ? new Date(expiresAt) : null,
  };
}

/**
 * What a soft-delete of `target` carries forward (F-57): for an account that is
 * already soft-deleted, the ban its latest soft-delete recorded, because the
 * ban this one replaces is that soft-delete's own; `undefined` for any other
 * account, whose current ban is the one to keep. Callers read it before
 * `banForSoftDelete` and outside its failure handling, as they read the record
 * before restore's ban step, so a failed read is the database fault it is (a
 * 500) and is never reported or audited as a Better Auth failure.
 */
export async function carriedPriorBan(target: {
  appUserId: string;
  status: string;
}): Promise<BanSnapshot | null | undefined> {
  return mustUseRestore(target) ? recordedPriorBan(target.appUserId) : undefined;
}

/**
 * Step 1 of a soft-delete, shared by `DELETE /users/[id]` and the
 * `soft_delete` bulk action: the indefinite Better Auth ban. Returns the ban it
 * replaced (`previousBan`, what the saga puts back if the cascade fails or is
 * refused) and the ban restore must put back (`priorBan`, F-57): `carried`
 * (`carriedPriorBan`) when set, since for an account that is already
 * soft-deleted the ban replaced is the first soft-delete's own.
 */
export async function banForSoftDelete(
  target: { betterAuthUserId: string },
  params: { banReason: string; actorBetterAuthUserId: string },
  carried: BanSnapshot | null | undefined,
): Promise<{ previousBan: BanSnapshot | null; priorBan: BanSnapshot | null }> {
  const { previousBan } = await banBetterAuthUser({
    userId: target.betterAuthUserId,
    banReason: params.banReason,
    // Omit `banExpiresIn` for indefinite per Better Auth semantics. A caller
    // soft-deleting themselves is refused here, before anything app-side
    // changes.
    actorBetterAuthUserId: params.actorBetterAuthUserId,
  });
  return { previousBan, priorBan: carried === undefined ? previousBan : carried };
}

/**
 * I-19 — A SOFT-DELETE REVOKES THE ACCOUNT'S BEARER CREDENTIALS.
 *
 * The last step of a soft-delete whose cascade has committed, shared by
 * `DELETE /users/[id]` and the `soft_delete` bulk action. A soft-delete used
 * to leave every API key the user owns, and every OAuth client acting as
 * them, `active`. They stopped working only while the owner stayed banned and
 * deactivated, so restore and then approve re-armed all of them, keys that
 * never expire included, with no rotation, even one that had leaked while the
 * account was deleted. So this revokes them with `revokeBearerCredentialsOf`,
 * the F-10 cut-off of a password reset (the ban has already ended the
 * sessions, which it requires first), with reason `owner_deleted`. Revoked is
 * final: restore leaves them revoked, and a restored user needs new
 * credentials. It runs only after the cascade commits, because a refused
 * (REVOKE-2) or failed soft-delete must leave the account as it was, and a
 * revoke cannot be undone.
 *
 * Then it writes the `admin.user.soft_deleted` row with the ban to keep
 * (F-57) and the revoked counts. That row is written even when the revocation
 * fails, because the deletion has committed and restore needs the record. The
 * failure is audited as `admin.user.soft_delete_failed`
 * (`credential_revocation_failed`) and returned, so the caller reports failure
 * and the operator retries: a repeated soft-delete revokes again.
 */
export async function finishSoftDelete(
  target: { appUserId: string; betterAuthUserId: string; primaryEmail: string },
  priorBan: BanSnapshot | null,
  audit: Pick<UserAuditContext, "request" | "actorBetterAuthUserId" | "organizationId"> & {
    /** Written to the revoked credentials' `revoked_by`; `null` records the account itself. */
    revokedByAppUserId: string | null;
    requestId?: string | null;
    reason: string | null;
    bulk?: boolean;
  },
): Promise<{ ok: true } | { ok: false; cause: unknown }> {
  const bulk = audit.bulk ? { bulk: true } : {};
  let revoked: { apiKeyIds: string[]; oauthClientIds: string[] } | null = null;
  let failure: { cause: unknown } | null = null;
  try {
    revoked = await revokeBearerCredentialsOf({
      betterAuthUserId: target.betterAuthUserId,
      trigger: "owner_deleted",
      actorBetterAuthUserId: audit.actorBetterAuthUserId,
      revokedByAppUserId: audit.revokedByAppUserId,
      request: audit.request,
      requestId: audit.requestId,
    });
  } catch (err) {
    failure = { cause: err };
  }
  const context = {
    request: audit.request,
    actorBetterAuthUserId: audit.actorBetterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    requestId: audit.requestId ?? null,
  };
  await auditUserAction(SOFT_DELETED_EVENT, "success", {
    ...context,
    organizationId: audit.organizationId,
    reason: audit.reason,
    metadata: {
      priorBan: banRecord(priorBan),
      ...(revoked
        ? {
            revokedApiKeys: revoked.apiKeyIds.length,
            revokedOauthClients: revoked.oauthClientIds.length,
          }
        : { credentialRevocationFailed: true }),
      ...bulk,
    },
  });
  if (failure === null) return { ok: true };
  await auditUserAction("admin.user.soft_delete_failed", "error", {
    ...context,
    organizationId: audit.organizationId,
    reason: "credential_revocation_failed",
    metadata: {
      message: failure.cause instanceof Error ? failure.cause.message : "unknown",
      ...bulk,
    },
  });
  return { ok: false, cause: failure.cause };
}

async function performSoftDelete(
  target: BulkUserTarget,
  actor: BulkUserActor,
  options: BulkUserOptions,
): Promise<BulkUserOutcome> {
  const refused = await refuseSharedAccountGlobal(target, actor);
  if (refused) return refused;
  const reason = options.reason ?? null;
  // A database read, so outside the ban's `auth_ban_failed` handling: it fails
  // as the shared-target read above does.
  const carried = await carriedPriorBan(target);
  let bans: { previousBan: BanSnapshot | null; priorBan: BanSnapshot | null };
  try {
    bans = await banForSoftDelete(
      target,
      { banReason: reason ?? "deleted", actorBetterAuthUserId: actor.betterAuthUserId },
      carried,
    );
  } catch (err) {
    await auditUserAction("admin.user.soft_delete_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: scopeOrganizationId(actor.scope),
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
      // would be the way around the single-row 409. F-56: measured as the ban
      // applied above, which the grant read would otherwise already see as
      // gone, emptying the set before this check could count it.
      if (await banStripsLastGlobalSuperuser(target, trx)) {
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
    // when the application bookkeeping fails (#B6): back to the ban it
    // replaced, not to no ban at all (F-57).
    try {
      await restoreBetterAuthBan(target.betterAuthUserId, bans.previousBan);
    } catch (unbanErr) {
      await auditUserAction("admin.user.soft_delete_compensation_failed", "error", {
        request: actor.request,
        actorBetterAuthUserId: actor.betterAuthUserId,
        appUserId: target.appUserId,
        organizationId: scopeOrganizationId(actor.scope),
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
        organizationId: scopeOrganizationId(actor.scope),
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
      organizationId: scopeOrganizationId(actor.scope),
      email: target.primaryEmail,
      reason: "db_cascade_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "db_cascade_failed" };
  }

  const finished = await finishSoftDelete(target, bans.priorBan, {
    request: actor.request,
    actorBetterAuthUserId: actor.betterAuthUserId,
    organizationId: scopeOrganizationId(actor.scope),
    revokedByAppUserId: actor.appUserId ?? null,
    requestId: actor.requestId,
    reason,
    bulk: true,
  });
  if (!finished.ok) {
    return { ok: false, appUserId: target.appUserId, error: "credential_revocation_failed" };
  }
  return { ok: true, appUserId: target.appUserId };
}

/**
 * F-152 — RESTORE HANDS EACH MEMBERSHIP BACK FOR RE-APPROVAL.
 *
 * Step 3 of a restore, shared by `POST /users/[id]/restore` and the `restore`
 * bulk action: every membership the soft-delete cascade snapshotted gets its
 * `pre_deactivation_status` back, except that an `active` one comes back
 * `pending_approval`. Restore used to revive `active` memberships behind
 * the account-level `pending_approval` alone, and any tenant could lift that:
 * another org's accepted invitation, or its admin's approval of a shared user,
 * made the account `active`, and every restored membership and its roles then
 * counted in orgs that had approved nothing. Now each org approves its own
 * membership again: the status actions, `PATCH …/memberships` or `…/members`,
 * or that org's own invitation.
 *
 * A membership this brings back `pending_approval` keeps its snapshot, the
 * marker that restore held it back, until the next write that sets its status
 * clears it. Sign-in re-evaluation skips a membership carrying it
 * (`reevaluatePendingActivation`), so an org's sign-up policy (`auto_active`,
 * an auto-approve domain) cannot activate what restore left for an approver,
 * as it may not for a user an administrator created pending (F-480). A
 * `blocked` or `suspended` membership comes back as it was, with no marker.
 *
 * The snapshot restore reads is the one the cascade took, or none: every write
 * that sets a membership's status clears it, so a decision an org made while
 * the account was deleted stands over it.
 */
export async function restoreSnapshottedMemberships(
  appUserId: string,
  executor: Kysely<AppDatabase>,
): Promise<void> {
  await executor
    .updateTable("app_organization_memberships")
    .set({
      // Both expressions read the row as it was before this UPDATE.
      status: sql<string>`case when pre_deactivation_status = 'active' then 'pending_approval' else pre_deactivation_status end`,
      pre_deactivation_status: sql<
        string | null
      >`case when pre_deactivation_status in ('active', 'pending_approval') then pre_deactivation_status end`,
      updated_at: sql`now()`,
    })
    .where("app_user_id", "=", appUserId)
    .where("pre_deactivation_status", "is not", null)
    .execute();
}

async function performRestore(
  target: BulkUserTarget,
  actor: BulkUserActor,
): Promise<BulkUserOutcome> {
  const refused = await refuseSharedAccountGlobal(target, actor);
  if (refused) return refused;
  // F-56: restore reverses a soft-delete and nothing else, as on the single-row
  // route (409 `not_deactivated`). Applied to any other account it moved the
  // user to `pending_approval`, a loss of sign-in REVOKE-2 does not gate (a
  // real restore never needs it: a soft-deleted account's grants do not
  // count), so the last superadmin could "restore" themselves out of the
  // console through this path.
  if (!mustUseRestore(target)) {
    return { ok: false, appUserId: target.appUserId, error: "not_deactivated" };
  }
  // F-57: an earlier ban the soft-delete replaced comes back. The record is a
  // database read, so it is outside the `auth_unban_failed` handling below.
  const priorBan = await recordedPriorBan(target.appUserId);
  let banned: boolean;
  try {
    ({ banned } = await restoreBetterAuthBan(target.betterAuthUserId, priorBan));
  } catch (err) {
    await auditUserAction("admin.user.restore_failed", "error", {
      request: actor.request,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: scopeOrganizationId(actor.scope),
      email: target.primaryEmail,
      reason: "auth_unban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown", bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "auth_unban_failed" };
  }
  // Reverse the cascade applied by performSoftDelete: any membership that
  // still carries a `pre_deactivation_status` snapshot gets it back, an
  // `active` one as `pending_approval` (F-152). Memberships without a snapshot
  // were never cascaded, or an org has decided them since — leave them alone.
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
    await restoreSnapshottedMemberships(target.appUserId, trx);
  });
  await auditUserAction("admin.user.restored", "success", {
    request: actor.request,
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: scopeOrganizationId(actor.scope),
    email: target.primaryEmail,
    metadata: { banReinstated: banned, bulk: true },
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
      organizationId: scopeOrganizationId(actor.scope),
      email: target.primaryEmail,
      requestId: actor.requestId ?? null,
      reason: "target_outranks_actor",
      metadata: { action, targetBetterAuthUserId: target.betterAuthUserId, bulk: true },
    });
    return { ok: false, appUserId: target.appUserId, error: "forbidden_target_outranks_actor" };
  }
  // F-57: a soft-deleted account leaves `deactivated` only through `restore`
  // (`deactivated-user.ts`). The status actions are refused again inside
  // `performAdminStatusChange`, against the row it locks; ban and unban have
  // no other check.
  if (action !== "soft_delete" && action !== "restore" && mustUseRestore(target)) {
    return { ok: false, appUserId: target.appUserId, error: USE_RESTORE_ERROR };
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
