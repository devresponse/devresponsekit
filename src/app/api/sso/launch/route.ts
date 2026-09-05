import { NextResponse, type NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { getCurrentSession, getImpersonatorId } from "@/lib/auth-guard";
import { createSsoHandoffRedirect } from "@/lib/sso.server";
import { isSsoHandoffSignerConfigured } from "@/lib/jwt-handoff.server";
import { APP_ID_RE } from "@/lib/admin/enterprise-apps";
import {
  DEFAULT_SSO_LAUNCH_LIMIT,
  actorIdFromRequest,
  enforceRateLimit,
} from "@/lib/admin/rate-limit.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { logServerError } from "@/lib/observability/logger.server";
import { captureServerError } from "@/lib/observability/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/sso/launch
 *
 * Generates a one-time, short-lived JWT handoff redirect for cross-
 * subdomain SSO. The token is never returned in JSON; failed launches
 * are always audit-logged. The success response sets
 * `Referrer-Policy: no-referrer` so the target subdomain cannot leak
 * the launching URL to third parties.
 *
 * Order of checks (review #4, #16):
 *   1. `applicationId` shape (`APP_ID_RE`) — a missing/malformed id is a
 *      plain 400 with NO database work and NO audit row: this is a public,
 *      SameSite=Lax-reachable GET, and an unauthenticated flood must not be
 *      able to write attacker-chosen strings into the append-only audit
 *      table.
 *   2. Per-principal rate limit (session user id, or trusted client IP while
 *      signed out) — bounds the audit/nonce/purge writes below.
 *   3. Session, then impersonation: an impersonated session is REFUSED. The
 *      satellite session the consumer would mint carries no `impersonatedBy`,
 *      outlives the impersonation cap, and is attributed to the target — it
 *      would launder the admin's impersonation into an unmarked session
 *      (and, on a shared-DB satellite, escape the tenant confinement that
 *      makes the impersonation escalation guard sound — see
 *      `/api/preferences/active-org`, P0-1).
 *   4. Signing key (review #5): `SSO_HANDOFF_PRIVATE_KEY` is OPTIONAL at boot
 *      (a consumer-only satellite never issues), so a deployment that tries
 *      to LAUNCH without one fails closed here — `503 sso_not_configured`,
 *      audited + logged — before any nonce/purge write.
 */
export async function GET(request: NextRequest) {
  const applicationId = request.nextUrl.searchParams.get("applicationId");
  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = localeParam && isSupportedLocale(localeParam) ? localeParam : defaultLocale;

  if (!applicationId) {
    return NextResponse.json({ error: "missing_application_id" }, { status: 400 });
  }
  if (!APP_ID_RE.test(applicationId)) {
    return NextResponse.json({ error: "invalid_application_id" }, { status: 400 });
  }

  const session = await getCurrentSession();

  const limited = enforceRateLimit(
    "sso.launch",
    session ? session.user.id : actorIdFromRequest(request),
    DEFAULT_SSO_LAUNCH_LIMIT,
    request,
  );
  if (limited) return limited;

  if (!session) {
    await auditEvent({
      eventType: "sso.launch.failure",
      outcome: "failure",
      reason: "unauthenticated",
      targetApplicationId: applicationId,
      request,
    });
    return NextResponse.redirect(new URL(`/${locale}/sign-in`, request.url));
  }

  const impersonatorId = getImpersonatorId(session);
  if (impersonatorId) {
    // Attribute the denial to the human behind the session (the admin), not
    // the impersonated target, so the audit row names who actually tried.
    await auditEvent({
      eventType: "sso.launch.failure",
      outcome: "denied",
      reason: "forbidden_while_impersonating",
      actorBetterAuthUserId: impersonatorId,
      targetApplicationId: applicationId,
      request,
      metadata: { impersonatedBetterAuthUserId: session.user.id },
    });
    return NextResponse.json({ error: "forbidden_while_impersonating" }, { status: 403 });
  }

  if (!isSsoHandoffSignerConfigured()) {
    const err = new Error("SSO_HANDOFF_PRIVATE_KEY is not configured");
    logServerError("sso.launch.config_error", {
      reason: "signing_key_not_configured",
      err,
    });
    captureServerError(err, { status: 503 });
    await auditEvent({
      eventType: "sso.launch.failure",
      outcome: "error",
      reason: "signing_key_not_configured",
      actorBetterAuthUserId: session.user.id,
      targetApplicationId: applicationId,
      request,
    });
    return NextResponse.json({ error: "sso_not_configured" }, { status: 503 });
  }

  try {
    const redirectUrl = await createSsoHandoffRedirect({
      applicationId,
      betterAuthUserId: session.user.id,
      request,
    });

    await auditEvent({
      eventType: "sso.launch.success",
      outcome: "success",
      actorBetterAuthUserId: session.user.id,
      targetApplicationId: applicationId,
      request,
    });

    const response = NextResponse.redirect(redirectUrl);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    await auditEvent({
      eventType: "sso.launch.failure",
      outcome: "failure",
      actorBetterAuthUserId: session.user.id,
      targetApplicationId: applicationId,
      reason: error instanceof Error ? error.message : "unknown_error",
      request,
    });
    return NextResponse.json({ error: "sso_launch_failed" }, { status: 403 });
  }
}
