import { NextResponse, type NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { getCurrentSession } from "@/lib/auth-guard";
import { createSsoHandoffRedirect } from "@/lib/sso.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/sso/launch
 *
 * Generates a one-time, short-lived JWT handoff redirect for cross-
 * subdomain SSO. The token is never returned in JSON; failed launches
 * are always audit-logged. The success response sets
 * `Referrer-Policy: no-referrer` so the target subdomain cannot leak
 * the launching URL to third parties.
 */
export async function GET(request: NextRequest) {
  const applicationId = request.nextUrl.searchParams.get("applicationId");
  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = localeParam && isSupportedLocale(localeParam) ? localeParam : defaultLocale;

  if (!applicationId) {
    await auditEvent({
      eventType: "sso.launch.failure",
      outcome: "failure",
      reason: "missing_application_id",
      request,
    });
    return NextResponse.json({ error: "missing_application_id" }, { status: 400 });
  }

  const session = await getCurrentSession();
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
