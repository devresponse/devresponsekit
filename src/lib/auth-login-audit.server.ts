import "server-only";
import { auditEvent } from "@/lib/audit.server";

/**
 * Audit event type recorded once per Better Auth session creation — i.e.
 * once per login. (A session refresh updates the existing row via `updateAge`
 * and does NOT fire the create hook, so this counts real logins, not
 * keep-alives.) It backs the "daily logins" dashboard metrics: system-wide
 * (superuser) and per-organization (org admin, joined via the actor's
 * memberships).
 */
export const LOGIN_EVENT_TYPE = "auth.session.created";

/**
 * Records a login. Best-effort: a failure here MUST NOT break sign-in, so it
 * swallows errors (auditEvent surfaces DB errors to its caller by design).
 * Called from the Better Auth `session.create.after` hook.
 */
export async function recordSessionLogin(
  betterAuthUserId: string,
  request?: { headers: Headers },
): Promise<void> {
  try {
    await auditEvent({
      eventType: LOGIN_EVENT_TYPE,
      outcome: "success",
      actorBetterAuthUserId: betterAuthUserId,
      request,
    });
  } catch {
    // A login must never fail because login-audit logging did.
  }
}
