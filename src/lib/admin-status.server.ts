import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";

/**
 * Shared admin status mutation logic.
 *
 * Validates that the caller is an admin (has `admin.users.manage`),
 * then updates the target user's status atomically and audits the
 * change with the admin event name appropriate for the action.
 *
 * Threat / contract:
 *   - Caller MUST hold `admin.users.manage` permission. Anything less
 *     returns 403 and is itself audit-logged as a denied attempt.
 *   - The `reason` field is optional and surfaces in audit metadata so
 *     ops teams can answer "who blocked this user and why".
 */
const requestSchema = z.object({
  appUserId: z.uuid(),
  reason: z.string().min(1).max(500).optional(),
});

const STATUS_TO_EVENT: Record<string, string> = {
  active: "admin.user.approved",
  blocked: "admin.user.blocked",
  suspended: "admin.user.suspended",
  // `active` after a previous suspension/block fires reactivated.
  reactivated: "admin.user.reactivated",
};

export interface AdminStatusActionInput {
  request: NextRequest;
  /** Target user status to set in `app_users.status`. */
  newStatus: "active" | "blocked" | "suspended" | "deactivated";
  /** Membership status to set on the user's primary membership. */
  newMembershipStatus: "active" | "blocked" | "suspended" | "pending_approval";
  /** Audit event override (used by reactivation). */
  eventOverride?: string;
}

export async function applyAdminStatusAction(input: AdminStatusActionInput) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const callerAccess = await getUserAccessContext(session.user.id);
  const callerDecision = decideSecureAccess(callerAccess.status, callerAccess.membershipStatus);
  if (callerDecision !== "allow" || !callerAccess.permissions.includes("admin.users.manage")) {
    await auditEvent({
      eventType: "administrator.access.denied",
      outcome: "denied",
      actorBetterAuthUserId: session.user.id,
      reason: "missing_admin_permission",
      request: input.request,
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await input.request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const target = await db
    .selectFrom("app_users")
    .select(["id", "primary_email"])
    .where("id", "=", parsed.data.appUserId)
    .executeTakeFirst();
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("app_users")
      .set({
        status: input.newStatus,
        status_reason: parsed.data.reason ?? null,
        updated_at: sql`now()`,
      })
      .where("id", "=", target.id)
      .execute();

    await trx
      .updateTable("app_organization_memberships")
      .set({ status: input.newMembershipStatus, updated_at: sql`now()` })
      .where("app_user_id", "=", target.id)
      .execute();
  });

  const eventType = input.eventOverride ?? STATUS_TO_EVENT[input.newStatus] ?? "admin.user.updated";

  await auditEvent({
    eventType,
    outcome: "success",
    actorBetterAuthUserId: session.user.id,
    appUserId: target.id,
    email: target.primary_email,
    reason: parsed.data.reason,
    request: input.request,
  });

  return NextResponse.json({ ok: true, status: input.newStatus });
}
