import { NextResponse, type NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { auth } from "@/lib/auth";
import { consumeSsoHandoffNonce } from "@/lib/sso.server";
import { verifySsoHandoff } from "@/lib/jwt-handoff.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { REQUEST_ID_HEADER, getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { logServerError } from "@/lib/observability/logger.server";
import { captureServerError } from "@/lib/observability/server";

export const dynamic = "force-dynamic";

/**
 * Error JSON for the SSO consume endpoint. Echoes the correlation id in both
 * the `x-request-id` header and the body so a failed handoff can be traced to
 * the audit row / server log (OPS-OBS-4) — the admin/v1 surfaces already do.
 */
function ssoErrorResponse(code: string, status: number, requestId: string): NextResponse {
  return NextResponse.json(
    { error: code, requestId },
    { status, headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

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
  // Mint/echo a correlation id up front (memoised per-request), so every
  // response — including the misconfig 500s below — and the audit rows share
  // one id (OPS-OBS-4).
  const requestId = getOrCreateRequestId(request);
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
    return ssoErrorResponse("missing_token", 400, requestId);
  }

  // A receiving deployment that is missing its audience config 500s on the
  // FIRST handoff but boots clean — a silent landmine. These branches `return`
  // (they do not throw), so `onRequestError` never fires; log + capture them
  // explicitly so the misconfiguration is visible in stdout and Sentry.
  const audiencePrefix = process.env.SSO_HANDOFF_AUDIENCE_PREFIX;
  if (!audiencePrefix) {
    const err = new Error("SSO_HANDOFF_AUDIENCE_PREFIX is not configured");
    logServerError("sso.consume.config_error", {
      requestId,
      reason: "audience_prefix_not_configured",
      err,
    });
    captureServerError(err, { requestId, status: 500 });
    return ssoErrorResponse("audience_not_configured", 500, requestId);
  }

  // SECURITY: do NOT derive the expected audience from the request Host
  // header — an attacker controlling DNS or a misconfigured proxy could
  // bypass audience validation. Each receiving deployment MUST configure
  // its own application id explicitly via `SSO_HANDOFF_APPLICATION_ID`.
  const applicationId = process.env.SSO_HANDOFF_APPLICATION_ID;
  if (!applicationId) {
    const err = new Error("SSO_HANDOFF_APPLICATION_ID is not configured");
    logServerError("sso.consume.config_error", {
      requestId,
      reason: "application_id_not_configured",
      err,
    });
    captureServerError(err, { requestId, status: 500 });
    return ssoErrorResponse("audience_not_configured", 500, requestId);
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
      return ssoErrorResponse("token_already_used", 401, requestId);
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
      return ssoErrorResponse("session_establishment_failed", 401, requestId);
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
    response.headers.set(REQUEST_ID_HEADER, requestId);
    // Forward the signed Better Auth session cookie(s) so the browser
    // lands on the dashboard already signed in. Use the dedicated
    // getSetCookie() accessor: iterating entries() collapses multiple
    // same-name headers into one comma-joined value, which corrupts a
    // Set-Cookie when Better Auth emits more than one (e.g. session token +
    // dont_remember) — browsers then fail to parse it (AUTH-3).
    for (const cookie of sessionHeaders.getSetCookie()) {
      response.headers.append("set-cookie", cookie);
    }
    return response;
  } catch (error) {
    await auditEvent({
      eventType: "sso.consume.failure",
      outcome: "failure",
      reason: error instanceof Error ? error.message : "unknown_error",
      request,
    });
    return ssoErrorResponse("invalid_token", 401, requestId);
  }
}
