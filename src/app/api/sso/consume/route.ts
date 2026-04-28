import { NextResponse, type NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { consumeSsoHandoffNonce } from "@/lib/sso.server";
import { verifySsoHandoff } from "@/lib/jwt-handoff.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/sso/consume
 *
 * Consumes an SSO handoff JWT issued by `/api/sso/launch`.
 *
 * Threat / contract:
 *   1. The token is verified against the configured signer/issuer and
 *      MUST match this application's audience (`SSO_HANDOFF_AUDIENCE_PREFIX`).
 *   2. The `jti` is consumed atomically before establishing any session,
 *      so a replayed token is rejected even on concurrent requests.
 *   3. The redirect to the localized landing page strips the token from
 *      the URL so it never appears in the browser history.
 *   4. The success response sets `Referrer-Policy: no-referrer`.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = localeParam && isSupportedLocale(localeParam) ? localeParam : defaultLocale;

  if (!token) {
    await auditEvent({
      eventType: "sso.consume.failure",
      outcome: "failure",
      reason: "missing_token",
      request,
    });
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const audiencePrefix = process.env.SSO_HANDOFF_AUDIENCE_PREFIX;
  if (!audiencePrefix) {
    return NextResponse.json({ error: "audience_not_configured" }, { status: 500 });
  }

  // The audience MUST be set to the receiving application's identifier;
  // for this scaffold we accept any audience that starts with the
  // configured prefix and matches the current host's app id.
  const expectedAudience = `${audiencePrefix}:${request.nextUrl.host.split(".")[0]}`;

  try {
    const verified = await verifySsoHandoff({ token, expectedAudience });
    const consumed = await consumeSsoHandoffNonce(verified.payload.jti);
    if (!consumed) {
      await auditEvent({
        eventType: "sso.consume.failure",
        outcome: "failure",
        reason: "nonce_replay_or_expired",
        request,
      });
      return NextResponse.json({ error: "token_already_used" }, { status: 401 });
    }

    await auditEvent({
      eventType: "sso.consume.success",
      outcome: "success",
      actorBetterAuthUserId: verified.payload.sub,
      targetApplicationId: verified.payload.targetApplicationId,
      request,
    });

    const dashboardUrl = new URL(`/${locale}/app/dashboard`, request.url);
    const response = NextResponse.redirect(dashboardUrl);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    await auditEvent({
      eventType: "sso.consume.failure",
      outcome: "failure",
      reason: error instanceof Error ? error.message : "unknown_error",
      request,
    });
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }
}
