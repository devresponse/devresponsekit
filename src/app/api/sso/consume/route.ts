import { NextResponse, type NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { auth } from "@/lib/auth";
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
 *   3. A real Better Auth session is then established for the verified
 *      `sub` through the server-only `sso-session` plugin endpoint
 *      (never mounted on HTTP) — banned/unknown users are rejected and
 *      the signed session cookie is forwarded on the redirect.
 *   4. The redirect to the localized landing page strips the token from
 *      the URL so it never appears in the browser history.
 *   5. The success response sets `Referrer-Policy: no-referrer`.
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

  // SECURITY: do NOT derive the expected audience from the request Host
  // header — an attacker controlling DNS or a misconfigured proxy could
  // bypass audience validation. Each receiving deployment MUST configure
  // its own application id explicitly via `SSO_HANDOFF_APPLICATION_ID`.
  const applicationId = process.env.SSO_HANDOFF_APPLICATION_ID;
  if (!applicationId) {
    return NextResponse.json({ error: "audience_not_configured" }, { status: 500 });
  }
  const expectedAudience = `${audiencePrefix}:${applicationId}`;

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

    // Establish the consumer-side session. The nonce is already burned,
    // so a failure here cannot be retried with the same token — that is
    // intentional: a token that reached session establishment was valid,
    // and the failure modes below (banned/unknown user, session store
    // down) all warrant a fresh launch.
    let sessionHeaders: Headers;
    try {
      const result = await auth.api.createSsoSession({
        body: { userId: verified.payload.sub },
        headers: request.headers,
        returnHeaders: true,
      });
      sessionHeaders = result.headers;
    } catch (err) {
      await auditEvent({
        eventType: "sso.consume.failure",
        outcome: "error",
        actorBetterAuthUserId: verified.payload.sub,
        targetApplicationId: verified.payload.targetApplicationId,
        reason: "session_establishment_failed",
        request,
        metadata: { message: err instanceof Error ? err.message : "unknown" },
      });
      return NextResponse.json({ error: "session_establishment_failed" }, { status: 401 });
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
    // Forward the signed Better Auth session cookie(s) so the browser
    // lands on the dashboard already signed in.
    for (const [name, value] of sessionHeaders.entries()) {
      if (name.toLowerCase() === "set-cookie") {
        response.headers.append("set-cookie", value);
      }
    }
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
