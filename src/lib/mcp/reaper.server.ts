import "server-only";
import { sql, type SqlBool } from "kysely";
import { db } from "@/db/database";

/**
 * Stale-registration reaper for MCP self-registration (review #13, #51).
 *
 * In `approval` mode every `POST /api/mcp/register` — including junk from an
 * unauthenticated caller — leaves a `pending_approval` service account +
 * membership + zero-scope client behind. Those never consume quota (see
 * `countSelfRegisteredMcpClientsForOrg`), but before this sweep they piled up
 * in the Agents console forever, burying a legitimate pending agent under
 * noise. The reaper EXPIRES every self-registered agent that is still
 * pending after `MCP_REGISTRATION_PENDING_TTL_DAYS`.
 *
 * Why expire rather than delete: the registration is audited against the
 * service user (`app_audit_events.app_user_id` → `app_users` with no cascade,
 * and the audit table is append-only), so the rows must stay. Expiring
 * mirrors the admin soft-delete cascade instead: user `deactivated` (with a
 * machine-readable reason), membership `blocked`, client `revoked` — the
 * principal is inert and the console files it under "Revoked".
 *
 * Race with an admin's Approve: both sides flip the `app_users` row with a
 * `status = 'pending_approval'` predicate, so exactly one wins; the
 * membership + client updates then follow ONLY the users this sweep actually
 * flipped, so an agent approved a moment earlier is never half-expired.
 *
 * Scope guard: `created_by = app_user_id` plus the `mcp` membership marks a
 * SELF-registered agent; an admin-created client, and an admin-created user
 * that merely sits in `pending_approval`, can never match.
 */

export const MCP_EXPIRED_REGISTRATION_REASON = "mcp_registration_expired";

export interface ReapResult {
  /** Self-registrations expired by this pass. */
  expired: number;
  /** TTL the pass ran with (0 = sweep disabled, nothing touched). */
  ttlDays: number;
}

/**
 * One reaper pass. Expires self-registered agents whose service user is still
 * `pending_approval` and whose client is older than `ttlDays`. Returns how
 * many were expired. `ttlDays <= 0` disables the sweep. Callers pass
 * `MCP_REGISTRATION_PENDING_TTL_DAYS` from the validated env — this module
 * stays env-free so it is importable by the cron script and the route alike.
 */
export async function expireStalePendingMcpRegistrations(ttlDays: number): Promise<ReapResult> {
  if (ttlDays <= 0) return { expired: 0, ttlDays };

  const expired = await db.transaction().execute(async (trx) => {
    // 1. Flip the USER rows first (this is the step that races Approve) and
    //    learn exactly which ones we won.
    const flipped = await trx
      .updateTable("app_users")
      .set({
        status: "deactivated",
        status_reason: MCP_EXPIRED_REGISTRATION_REASON,
        deactivated_at: sql`now()`,
        deactivated_reason: MCP_EXPIRED_REGISTRATION_REASON,
        updated_at: sql`now()`,
      })
      .where("status", "=", "pending_approval")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("app_oauth_clients as c")
            .select("c.id")
            .whereRef("c.app_user_id", "=", "app_users.id")
            .whereRef("c.created_by", "=", "c.app_user_id")
            .where("c.status", "=", "active")
            .where(sql<SqlBool>`c.created_at < now() - make_interval(days => ${ttlDays}::int)`)
            .where((inner) =>
              inner.exists(
                inner
                  .selectFrom("app_organization_memberships as m")
                  .select("m.id")
                  .whereRef("m.app_user_id", "=", "c.app_user_id")
                  .whereRef("m.organization_id", "=", "c.organization_id")
                  .where("m.source_provider", "=", "mcp"),
              ),
            ),
        ),
      )
      .returning("id")
      .execute();
    const userIds = flipped.map((row) => row.id);
    if (userIds.length === 0) return 0;

    // 2. Cascade to the memberships and clients of the users we flipped —
    //    the same shape as the admin soft-delete cascade (blocked + revoked).
    await trx
      .updateTable("app_organization_memberships")
      .set({ pre_deactivation_status: sql`status`, status: "blocked", updated_at: sql`now()` })
      .where("app_user_id", "in", userIds)
      .where("source_provider", "=", "mcp")
      .where("status", "!=", "blocked")
      .execute();
    await trx
      .updateTable("app_oauth_clients")
      .set({ status: "revoked", revoked_at: sql`now()` })
      .where("app_user_id", "in", userIds)
      .whereRef("created_by", "=", "app_user_id")
      .where("status", "=", "active")
      .execute();
    return userIds.length;
  });

  return { expired, ttlDays };
}
