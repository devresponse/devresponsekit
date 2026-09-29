import "server-only";
import type { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { hasCrossOrgReach, type AccessLike } from "@/lib/admin/access-scope.server";
import {
  rateLimitDeniedResponse,
  rateLimitKey,
  type RateLimitOptions,
} from "@/lib/admin/rate-limit.server";
import { consumeSharedToken } from "@/lib/admin/rate-limit-shared.server";
import { humanActorFor } from "@/lib/impersonation-attribution.server";

/**
 * F-64 — MAIL AN ADMINISTRATOR SENDS HAS A BUDGET EVERY INSTANCE SHARES.
 *
 * Four admin actions make the platform mail someone from its own sending
 * domain: the test email, creating an organization invitation, resending one,
 * and the password-reset email an admin sends a user. All four were throttled
 * only by the per-actor, per-process mutation bucket (30 burst, then 1/s), so
 * one org admin could script about 86,400 platform-branded mails a day per
 * instance: to any address through the test email and invitations, or to one
 * victim through a resend loop. The provider's quota and the domain's sending
 * reputation are shared by every tenant, so a burst like that stalls everyone
 * else's password-reset and verification mail too.
 *
 * The recipient rule lives in the test-email route (an org admin mails only
 * their own address). The budgets live here, in Postgres, so they hold across
 * instances:
 *
 *   - PER RECIPIENT ({@link enforceRecipientCooldown}): one mail per
 *     {@link ADMIN_MAIL_RECIPIENT_COOLDOWN} to the recipient a resend or a reset
 *     email is bound to (the invitation, the user), from the shared bucket.
 *   - PER ORGANIZATION ({@link enforceOrgAdminMailBudget}): at most
 *     {@link ORG_ADMIN_MAIL_DAILY_LIMIT} of these mails in any rolling 24 hours
 *     for an org-confined caller. The shared bucket cannot hold a daily window:
 *     it refuses a budget slower than an hour to refill, because its prune
 *     would hand a half-spent bucket a fresh one. So this budget COUNTS the
 *     audit rows the four actions already write ({@link ADMIN_MAIL_EVENTS}),
 *     stamped with the org they mailed for (F-32). Those rows are durable,
 *     append-only and shared by every instance. The count is taken before the
 *     send and the row written after it, so concurrent requests can overshoot
 *     by the number in flight. The per-actor buckets bound that per actor, not
 *     per org: an org admin who creates more admins or API keys adds a burst
 *     for each. A hard cap would need the check serialized per org; not done.
 *
 * A caller with cross-org reach (an unbound superadmin session) is not held to
 * an org's daily budget: it is the platform operator, not a tenant, and its
 * invitations into an org still count toward that org's total. The per-actor
 * and per-recipient budgets apply to everyone.
 */

/**
 * The audit event each mail-sending admin action writes. The daily budget
 * counts exactly these, so the routes name their rows through this object.
 */
export const ADMIN_MAIL_EVENTS = {
  testEmail: "admin.email.test_sent",
  invitationCreated: "admin.organization.invitation_created",
  invitationResent: "admin.organization.invitation_resent",
  passwordResetEmail: "admin.user.password_reset_email_sent",
} as const;

/** Admin-initiated mails one organization may send in any rolling 24 hours. */
export const ORG_ADMIN_MAIL_DAILY_LIMIT = 200;

/** The scope a refusal from the daily budget is counted and audited under. */
export const ORG_ADMIN_MAIL_BUDGET_SCOPE = "admin.mail.org_daily";

/**
 * The test email's per-actor budget, from the shared bucket: a burst of 10,
 * refilled over an hour. Enough to debug a provider configuration, not enough
 * to be a mailing list.
 */
export const ADMIN_TEST_EMAIL_LIMIT: RateLimitOptions = {
  capacity: 10,
  refillPerSec: 10 / 3600,
};

/** One mail to the same recipient per 10 minutes (a resend, a reset email). */
export const ADMIN_MAIL_RECIPIENT_COOLDOWN: RateLimitOptions = {
  capacity: 1,
  refillPerSec: 1 / 600,
};

/** The slice of the permission grant these budgets charge and audit. */
export interface MailingGuard {
  access: AccessLike;
  betterAuthUserId: string;
  requestId: string;
}

/**
 * Refuses (429 `rate_limited`, with `Retry-After` until the oldest counted mail
 * leaves the window) when `organizationId` has sent
 * {@link ORG_ADMIN_MAIL_DAILY_LIMIT} admin mails in the last 24 hours. Returns
 * `null` to proceed, and always for a caller with cross-org reach or for an
 * org-less (platform) send.
 */
export async function enforceOrgAdminMailBudget(
  guard: MailingGuard,
  organizationId: string | null,
  request: { headers: Headers },
): Promise<NextResponse | null> {
  if (organizationId === null || hasCrossOrgReach(guard.access)) return null;
  // Only the newest LIMIT rows are read, so a refusal costs a bounded scan.
  const recent = db
    .selectFrom("app_audit_events")
    .select("created_at")
    .where("organization_id", "=", organizationId)
    .where("event_type", "in", Object.values(ADMIN_MAIL_EVENTS))
    // Raw, as in the audit route: `created_at` is a `Generated<Timestamp>`.
    .where(sql<boolean>`created_at > now() - interval '24 hours'`)
    .orderBy("created_at", "desc")
    .limit(ORG_ADMIN_MAIL_DAILY_LIMIT)
    .as("recent");
  const usage = await db
    .selectFrom(recent)
    .select([
      sql<number>`count(*)::int`.as("sent"),
      // Seconds until the oldest counted row leaves the window.
      sql<number | null>`
        ceil(extract(epoch from (min(recent.created_at) + interval '24 hours' - now())))::int
      `.as("retry_after"),
    ])
    .executeTakeFirstOrThrow();
  if (usage.sent < ORG_ADMIN_MAIL_DAILY_LIMIT) return null;
  return rateLimitDeniedResponse(
    ORG_ADMIN_MAIL_BUDGET_SCOPE,
    humanActorFor(guard.betterAuthUserId, request),
    { ok: false, retryAfterSeconds: Math.max(1, usage.retry_after ?? 1) },
    request,
    guard.requestId,
  );
}

/**
 * Takes one token from the shared {@link ADMIN_MAIL_RECIPIENT_COOLDOWN} bucket
 * of `recipientKey` (an invitation id, a user id) under `scope`. The bucket is
 * keyed on the recipient, so every admin shares it; the refusal is charged to
 * and audited as the human caller (F-07), never as the recipient.
 */
export async function enforceRecipientCooldown(
  scope: string,
  recipientKey: string,
  guard: MailingGuard,
  request: { headers: Headers },
): Promise<NextResponse | null> {
  const result = await consumeSharedToken(
    rateLimitKey(scope, recipientKey),
    ADMIN_MAIL_RECIPIENT_COOLDOWN,
  );
  if (result.ok) return null;
  return rateLimitDeniedResponse(
    scope,
    humanActorFor(guard.betterAuthUserId, request),
    result,
    request,
    guard.requestId,
  );
}
