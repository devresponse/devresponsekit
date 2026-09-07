import "server-only";
import type { NextRequest } from "next/server";
import { sql, type SqlBool } from "kysely";
import { db } from "@/db/database";
import { userHasMembershipOutsideOrg, type OrgScope } from "@/lib/admin/access-scope.server";
import { auditEvent } from "@/lib/audit.server";

/**
 * Shared admin status mutation core.
 *
 * Updates the target user's status (and the status of all their
 * organization memberships) atomically and audits the change with the
 * admin event name appropriate for the action.
 *
 * Threat / contract:
 *   - This function performs NO permission check. Callers MUST gate it
 *     behind `requireAdminPermission("admin.users.manage")` (the
 *     /status route and the bulk endpoint both do). Centralizing the
 *     mutation without re-resolving the session keeps bulk batches at
 *     one session/permission check per request instead of per row.
 *   - It DOES enforce tenant scope (AUTHZ-1): for an org admin acting on a
 *     user shared with other orgs, the mutation is confined to the actor's
 *     org membership and never changes the account-global status (except a
 *     grant may lift a still-pending account so it becomes usable). A
 *     SUPERADMIN (`scope.kind === "all"`) retains account-global authority.
 *   - The `reason` field is optional and surfaces in audit metadata so
 *     ops teams can answer "who blocked this user and why". Callers
 *     validate its length (max 500) at the route schema.
 */
export interface AdminStatusChangeInput {
  /** Better Auth user id of the acting administrator (audited). */
  actorBetterAuthUserId: string;
  /**
   * The actor's tenant scope (AUTHZ-1). SUPERADMIN → `{ kind: "all" }`
   * (account-global); org admin → `{ kind: "org", organizationId }` (confined
   * to that org). Derive from `resolveOrgScope(guard.access)`.
   */
  scope: OrgScope;
  /** Request context for the audit row's IP / UA / request-id. */
  request?: NextRequest | { headers: Headers };
  /** Correlation id shared with the route's other audit rows. */
  requestId?: string;
  /** `app_users.id` of the target. */
  targetAppUserId: string;
  /** Target user status to set in `app_users.status`. */
  newStatus: "active" | "blocked" | "suspended" | "deactivated";
  /** Membership status cascaded to the user's memberships. */
  newMembershipStatus: "active" | "blocked" | "suspended" | "pending_approval";
  /** Audit event name (e.g. `admin.user.approved`). */
  eventType: string;
  /** Optional operator-supplied reason, stored and audited. */
  reason?: string;
  /**
   * Optimistic-concurrency version the caller read the row at (review #44).
   *
   * When present, the mutation becomes a COMPARE-AND-SWAP: the row is claimed
   * with `updated_at` in the UPDATE's own WHERE, inside the transaction, so a
   * writer whose read is stale by the time it writes loses (`precondition_
   * failed`) instead of silently overwriting the winner. Omit for
   * last-write-wins (no `If-Match` sent, or the bulk/console paths).
   *
   * The comparison is at MILLISECOND granularity because that is the
   * granularity the ETag publishes: `updated_at` is a Postgres `timestamptz`
   * (microseconds) but arrives as a JS `Date` (milliseconds), so an exact
   * `updated_at = $1` predicate would never match a row whose stored value has
   * a sub-millisecond component.
   */
  expectedUpdatedAt?: Date;
}

export type AdminStatusChangeResult =
  | { ok: true; status: AdminStatusChangeInput["newStatus"] }
  | { ok: false; error: "not_found" | "precondition_failed" };

/** Internal signal used to roll the transaction back on a lost CAS (#44). */
class PreconditionFailedError extends Error {}

export async function performAdminStatusChange(
  input: AdminStatusChangeInput,
): Promise<AdminStatusChangeResult> {
  const target = await db
    .selectFrom("app_users")
    .select(["id", "primary_email"])
    .where("id", "=", input.targetAppUserId)
    .executeTakeFirst();
  if (!target) {
    return { ok: false, error: "not_found" };
  }

  const orgScoped = input.scope.kind === "org";
  // For an org admin acting on a user shared with OTHER orgs, the action must
  // not change that user's access outside the actor's org (AUTHZ-1).
  const shared =
    input.scope.kind === "org"
      ? await userHasMembershipOutsideOrg(target.id, input.scope.organizationId)
      : false;
  const isGrant = input.newStatus === "active";

  try {
    await db.transaction().execute(async (trx) => {
      // review #44: CLAIM the row before touching anything else. This UPDATE
      // is the compare-and-swap — the expected version rides in its WHERE, so
      // Postgres, not application code, decides the winner:
      //
      //   - it takes the row lock, so a concurrent claim blocks here;
      //   - when the first transaction commits, the blocked one re-evaluates
      //     this predicate against the NEW row version (READ COMMITTED
      //     EvalPlanQual), finds `updated_at` moved, and updates ZERO rows.
      //
      // The previous shape read `updated_at` in the route, compared it there,
      // and then wrote unconditionally — a check-then-act with a wide window
      // in which BOTH writers passed the precondition and both wrote.
      if (input.expectedUpdatedAt) {
        const claim = await trx
          .updateTable("app_users")
          .set({ updated_at: sql`now()` })
          .where("id", "=", target.id)
          .where(sql<SqlBool>`date_trunc('milliseconds', updated_at) = ${input.expectedUpdatedAt}`)
          .executeTakeFirst();
        if (Number(claim.numUpdatedRows ?? 0) === 0) throw new PreconditionFailedError();
      }
      // Account-global status:
      //  - SUPERADMIN, or a single-org user managed by their org admin → the
      //    account status mirrors the action (unchanged behavior).
      //  - Shared user + org admin → only LIFT a still-pending account to
      //    active on a grant (so it becomes usable); never change it on a deny,
      //    which would block the user in every other org too.
      //  - SUPERADMIN, or a single-org user managed by their org admin → the
      //    account status mirrors the action (unchanged behavior).
      //  - Shared user + org admin → only LIFT a still-pending account to
      //    active on a grant (so it becomes usable); never change it on a deny,
      //    which would block the user in every other org too.
      if (!orgScoped || !shared) {
        await trx
          .updateTable("app_users")
          .set({
            status: input.newStatus,
            status_reason: input.reason ?? null,
            updated_at: sql`now()`,
          })
          .where("id", "=", target.id)
          .execute();
      } else if (isGrant) {
        await trx
          .updateTable("app_users")
          .set({ status: "active", updated_at: sql`now()` })
          .where("id", "=", target.id)
          .where("status", "=", "pending_approval")
          .execute();
      }

      // Membership status: every org for a SUPERADMIN (account-global); only
      // the actor's own org for an org admin (the AUTHZ-1 confinement).
      let membership = trx
        .updateTable("app_organization_memberships")
        .set({ status: input.newMembershipStatus, updated_at: sql`now()` })
        .where("app_user_id", "=", target.id);
      if (input.scope.kind === "org") {
        membership = membership.where("organization_id", "=", input.scope.organizationId);
      }
      await membership.execute();
    });
  } catch (err) {
    // A lost CAS is an expected outcome, not a fault: the transaction rolled
    // back untouched and the caller answers 412 (review #44).
    if (err instanceof PreconditionFailedError) return { ok: false, error: "precondition_failed" };
    throw err;
  }

  await auditEvent({
    eventType: input.eventType,
    outcome: "success",
    actorBetterAuthUserId: input.actorBetterAuthUserId,
    appUserId: target.id,
    email: target.primary_email,
    reason: input.reason,
    request: input.request,
    requestId: input.requestId,
  });

  return { ok: true, status: input.newStatus };
}
