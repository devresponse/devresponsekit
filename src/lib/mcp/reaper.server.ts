import "server-only";
import { sql, type SqlBool } from "kysely";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";

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
 *
 * F-75 — bounded batches, and no id ever leaves the database. The first
 * version flipped EVERY stale user in one UPDATE, read their ids back, and
 * sent them as `IN ($1, …, $n)` to the two cascades. node-postgres writes the
 * parameter count as a 16-bit field, so a backlog of about 65,533 stale
 * registrations (a day of an approval-mode flood against the public endpoint,
 * or a cron that never ran) made that statement unsendable. The transaction
 * rolled back, every later pass saw a bigger backlog, and the reaper stayed
 * broken until someone wrote SQL by hand. Now each pass runs one statement per
 * batch: data-modifying CTEs flip at most `batchSize` users and cascade to
 * their memberships and clients through `IN (SELECT id FROM flipped)`, so the
 * statement binds the same handful of parameters whatever the backlog. A
 * statement is atomic on its own, so a batch commits or rolls back whole, and
 * a pass that stops part way keeps the batches it finished. The batch takes
 * its users `FOR UPDATE SKIP LOCKED`, so a second pass running at the same
 * time (the cron tick and `pnpm mcp:reap`) takes the next rows instead of
 * queueing behind this one's and then losing every one of them on the pending
 * re-check. It loops until a batch expires nothing, rather than until a short
 * one, so a row lost to a concurrent Approve does not end the pass early. A
 * caller with a hard time limit (the serverless cron route) passes a
 * `deadline`: no batch starts after it, and the next pass takes the rest. A
 * flood-sized backlog measured about 1.2 ms per agent locally, mostly the audit
 * row below, so 65,600 agents need about 80 s, more than the route's 60.
 *
 * F-79 — every expiry is audited. The sweep revokes credentials, and it used
 * to leave nothing in the append-only log but the `mcp.client.registered` row,
 * so an operator asking why an agent was revoked had only `status_reason` on
 * the user row to go on. Each expired agent now gets an `mcp.client.expired`
 * row: no actor (nobody acted; the client's `revoked_by` stays NULL for the
 * same reason), `reason` = {@link MCP_EXPIRED_REGISTRATION_REASON}, the service
 * user and organization as its subject, and the client in `metadata`. Written
 * on the pool AFTER the batch commits, per the DB-4 rule in `audit.server.ts`:
 * a transaction handle is only for an audit naming a row the same
 * transaction deletes, and the reaper deletes nothing.
 */

export const MCP_EXPIRED_REGISTRATION_REASON = "mcp_registration_expired";

/**
 * Users one reaper statement expires (F-75). Bounds each statement's locks and
 * run time, and the number of `mcp.client.expired` audit rows written after it
 * commits; the loop in {@link expireStalePendingMcpRegistrations} does the
 * rest.
 */
export const MCP_REAP_BATCH_SIZE = 500;

export interface ReapOptions {
  /** Users per statement; defaults to {@link MCP_REAP_BATCH_SIZE}. */
  batchSize?: number;
  /**
   * Epoch milliseconds after which no further batch starts (F-75). Checked
   * after each batch and its audit rows, so the batch in hand always finishes.
   */
  deadline?: number;
}

export interface ReapResult {
  /** Self-registrations expired by this pass. */
  expired: number;
  /** TTL the pass ran with (0 = sweep disabled, nothing touched). */
  ttlDays: number;
  /**
   * False when the pass stopped at its `deadline` (F-75), so stale
   * registrations may remain for the next pass.
   */
  drained: boolean;
}

/** One expired agent, as the batch statement returns it for the audit. */
interface ExpiredAgent {
  appUserId: string;
  /** The revoked client; null only if an admin revoked it a moment earlier. */
  clientRowId: string | null;
  clientId: string | null;
  /** From the agent's `mcp` membership, which the batch requires to exist. */
  organizationId: string | null;
}

/**
 * One reaper pass. Expires self-registered agents whose service user is still
 * `pending_approval` and whose client is older than `ttlDays`, in batches,
 * and audits each one. Returns how many were expired. `ttlDays <= 0` disables
 * the sweep. Callers pass `MCP_REGISTRATION_PENDING_TTL_DAYS` from the
 * validated env — this module stays env-free so it is importable by the cron
 * script and the route alike.
 */
export async function expireStalePendingMcpRegistrations(
  ttlDays: number,
  options: ReapOptions = {},
): Promise<ReapResult> {
  if (ttlDays <= 0) return { expired: 0, ttlDays, drained: true };
  const batchSize = options.batchSize ?? MCP_REAP_BATCH_SIZE;

  let expired = 0;
  for (;;) {
    const batch = await expireBatch(ttlDays, batchSize);
    // Empty, not short: see the module doc (F-75). The loop ends because a
    // flipped user is no longer `pending_approval`, and a registration made
    // during the pass is younger than the TTL. A row another transaction holds
    // is skipped, not waited on; it is the next pass's if still pending.
    if (batch.length === 0) return { expired, ttlDays, drained: true };
    expired += new Set(batch.map((agent) => agent.appUserId)).size;
    for (const agent of batch) {
      await auditEvent({
        eventType: "mcp.client.expired",
        outcome: "success",
        appUserId: agent.appUserId,
        organizationId: agent.organizationId,
        reason: MCP_EXPIRED_REGISTRATION_REASON,
        metadata: { clientId: agent.clientId, clientRowId: agent.clientRowId, ttlDays },
      });
    }
    // Stop between batches, never inside one: a caller killed at its time
    // limit would lose the audit rows of a batch that already committed.
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { expired, ttlDays, drained: false };
    }
  }
}

/**
 * Expires up to `batchSize` stale agents in ONE statement (F-75) and returns
 * them. The batch is picked and locked first, then the user flip (the step
 * that races Approve); the membership and client cascades read its RETURNING
 * set, so they follow only the users this statement won.
 */
async function expireBatch(ttlDays: number, batchSize: number): Promise<ExpiredAgent[]> {
  return (
    db
      // The batch: at most `batchSize` stale self-registrations, locked
      // `SKIP LOCKED` so rows a concurrent pass (or an Approve in flight)
      // holds are left to it and this pass takes the next ones. MATERIALIZED,
      // so it runs once. Written as an `IN (…)` subquery of the flip, it was
      // planned as the inner side of a nested loop and re-run for each row;
      // each run skipped the rows this statement had already locked, so the
      // LIMIT bounded nothing (measured: batchSize 2 flipped 5).
      .with(
        (cte) => cte("batch").materialized(),
        (qc) =>
          qc
            .selectFrom("app_users as u")
            .select("u.id")
            .where("u.status", "=", "pending_approval")
            .where((inner) =>
              inner.exists(
                inner
                  .selectFrom("app_oauth_clients as c")
                  .select("c.id")
                  .whereRef("c.app_user_id", "=", "u.id")
                  .whereRef("c.created_by", "=", "c.app_user_id")
                  .where("c.status", "=", "active")
                  .where(
                    sql<SqlBool>`c.created_at < now() - make_interval(days => ${ttlDays}::int)`,
                  )
                  .where((member) =>
                    member.exists(
                      member
                        .selectFrom("app_organization_memberships as m")
                        .select("m.id")
                        .whereRef("m.app_user_id", "=", "c.app_user_id")
                        .whereRef("m.organization_id", "=", "c.organization_id")
                        .where("m.source_provider", "=", "mcp"),
                    ),
                  ),
              ),
            )
            .limit(batchSize)
            .forUpdate(["u"])
            .skipLocked(),
      )
      .with("flipped", (qc) =>
        qc
          .updateTable("app_users")
          .set({
            status: "deactivated",
            status_reason: MCP_EXPIRED_REGISTRATION_REASON,
            deactivated_at: sql`now()`,
            deactivated_reason: MCP_EXPIRED_REGISTRATION_REASON,
            updated_at: sql`now()`,
          })
          // Re-asserted on the row itself, not only in `batch`: when an Approve
          // commits first, the re-check on the new row version fails and this
          // statement skips the row. (The batch's lock re-checks it too; this
          // keeps the guard where the UPDATE is.)
          .where("status", "=", "pending_approval")
          .where("id", "in", (eb) => eb.selectFrom("batch").select("batch.id"))
          .returning("id"),
      )
      // The same shape as the admin soft-delete cascade (blocked + revoked). A
      // data-modifying CTE runs to completion whether or not the final SELECT
      // reads it, so `blocked` needs no RETURNING.
      .with("blocked", (qc) =>
        qc
          .updateTable("app_organization_memberships")
          .set({ pre_deactivation_status: sql`status`, status: "blocked", updated_at: sql`now()` })
          .where("app_user_id", "in", (eb) => eb.selectFrom("flipped").select("flipped.id"))
          .where("source_provider", "=", "mcp")
          .where("status", "!=", "blocked"),
      )
      .with("revoked", (qc) =>
        qc
          .updateTable("app_oauth_clients")
          .set({ status: "revoked", revoked_at: sql`now()` })
          .where("app_user_id", "in", (eb) => eb.selectFrom("flipped").select("flipped.id"))
          .whereRef("created_by", "=", "app_user_id")
          .where("status", "=", "active")
          .returning(["id", "client_id", "app_user_id", "organization_id"]),
      )
      // Driven by the FLIPPED users, so an agent whose client an admin revoked a
      // moment earlier is still audited (with no client). The organization
      // comes from the agent's `mcp` membership, not from `revoked`, so that
      // agent's row still names it: an org admin's audit view filters on it.
      // The main query reads the membership as the statement found it; its
      // organization_id is the same after `blocked`.
      .selectFrom("flipped")
      .leftJoin("revoked", "revoked.app_user_id", "flipped.id")
      .leftJoin("app_organization_memberships as m", (join) =>
        join.onRef("m.app_user_id", "=", "flipped.id").on("m.source_provider", "=", "mcp"),
      )
      .select([
        "flipped.id as appUserId",
        "revoked.id as clientRowId",
        "revoked.client_id as clientId",
        "m.organization_id as organizationId",
      ])
      .execute()
  );
}
