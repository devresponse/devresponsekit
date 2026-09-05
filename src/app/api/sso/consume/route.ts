import { NextResponse, type NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { auth } from "@/lib/auth";
import { withTrustedClientIp } from "@/lib/client-ip";
import { consumeSsoHandoffNonce } from "@/lib/sso.server";
import { verifySsoHandoff, type VerifiedSsoHandoff } from "@/lib/jwt-handoff.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { REQUEST_ID_HEADER, getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import {
  DEFAULT_SSO_CONSUME_LIMIT,
  actorIdFromRequest,
  enforceRateLimit,
} from "@/lib/admin/rate-limit.server";
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
 * Per-IP throttle for both consume methods (review #16). The endpoint is
 * public and every rejected call writes an append-only audit row, so an
 * unauthenticated curl loop must hit a ceiling before it reaches the audit
 * table. Keyed on the trusted-hop client IP (P2-4) — there is no principal
 * until the token verifies. Runs before any audit/DB work.
 */
function rateLimitConsume(request: NextRequest, requestId: string): NextResponse | null {
  return enforceRateLimit(
    "sso.consume",
    actorIdFromRequest(request),
    DEFAULT_SSO_CONSUME_LIMIT,
    request,
    requestId,
  );
}

/**
 * Resolves the audience this deployment accepts, or an error response. A
 * receiving deployment missing its audience config 500s on the FIRST handoff
 * but boots clean — a silent landmine — so log + capture it (OPS-OBS-4).
 *
 * Also returns the bare `applicationId`: the token's `targetApplicationId`
 * claim MUST equal it (review #15). `aud` alone is not enough — `sso_audience`
 * is an admin-typed column, so two registered apps can carry the same
 * audience (misconfiguration, or an org admin shadowing another org's
 * satellite) and a token minted for the other app would otherwise pass here.
 */
function resolveExpectedAudience(
  requestId: string,
): { audience: string; applicationId: string } | { error: NextResponse } {
  const audiencePrefix = process.env.SSO_HANDOFF_AUDIENCE_PREFIX;
  if (!audiencePrefix) {
    const err = new Error("SSO_HANDOFF_AUDIENCE_PREFIX is not configured");
    logServerError("sso.consume.config_error", {
      requestId,
      reason: "audience_prefix_not_configured",
      err,
    });
    captureServerError(err, { requestId, status: 500 });
    return { error: ssoErrorResponse("audience_not_configured", 500, requestId) };
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
    return { error: ssoErrorResponse("audience_not_configured", 500, requestId) };
  }
  return { audience: `${audiencePrefix}:${applicationId}`, applicationId };
}

/**
 * Binds a verified token to THIS deployment's application id (review #15).
 * Throws the same way `verifySsoHandoff` does so the callers' catch blocks
 * audit + 401 uniformly; the reason string lands in the audit row.
 */
function assertTargetApplication(
  payload: VerifiedSsoHandoff["payload"],
  applicationId: string,
): void {
  if (payload.targetApplicationId !== applicationId) {
    throw new Error("target_application_mismatch");
  }
}

function landingLocale(payloadLocale: unknown, fallback: string | null): string {
  if (typeof payloadLocale === "string" && isSupportedLocale(payloadLocale)) return payloadLocale;
  if (fallback && isSupportedLocale(fallback)) return fallback;
  return defaultLocale;
}

/**
 * GET /api/sso/consume
 *
 * Consumes an SSO handoff JWT issued by `/api/sso/launch`. Because the handoff
 * is IdP-initiated and the consumer runs on a (possibly different) origin, the
 * GET must NOT silently establish a session: an attacker could launch for their
 * OWN account, capture the consume URL from the 307 Location, and deliver it to
 * a victim within the token TTL — signing the victim into the attacker's
 * account (login-CSRF / session fixation, P2-2).
 *
 * Instead the GET only VERIFIES the token (no nonce burn, no session) and
 * redirects to a localized confirmation interstitial that shows the account
 * being signed into and requires an explicit, same-origin POST (below) to
 * proceed. A victim sees the unfamiliar account and stops; a cross-site
 * auto-submit is blocked by the POST's trusted-origin check.
 *
 * The success path sets `Referrer-Policy: no-referrer` so the token never
 * leaks via the Referer header.
 */
export async function GET(request: NextRequest) {
  // Mint/echo a correlation id up front (memoised per-request), so every
  // response and the audit rows share one id (OPS-OBS-4).
  const requestId = getOrCreateRequestId(request);
  const limited = rateLimitConsume(request, requestId);
  if (limited) return limited;

  const token = request.nextUrl.searchParams.get("token");
  const localeParam = request.nextUrl.searchParams.get("locale");

  if (!token) {
    await auditEvent({
      eventType: "sso.consume.failure",
      outcome: "failure",
      reason: "missing_token",
      request,
    });
    return ssoErrorResponse("missing_token", 400, requestId);
  }

  const aud = resolveExpectedAudience(requestId);
  if ("error" in aud) return aud.error;

  try {
    const verified = await verifySsoHandoff({ token, expectedAudience: aud.audience });
    assertTargetApplication(verified.payload, aud.applicationId);
    // Verified but NOT yet consumed: hand off to the confirmation page. The
    // nonce stays live (≤ TTL) until the user confirms via POST.
    const locale = landingLocale(verified.payload.locale, localeParam);
    const confirmUrl = new URL(`/${locale}/sso/confirm`, request.url);
    confirmUrl.searchParams.set("token", token);
    const response = NextResponse.redirect(confirmUrl);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    response.headers.set(REQUEST_ID_HEADER, requestId);
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

/**
 * POST /api/sso/consume
 *
 * The confirmation step: the localized interstitial (`/[locale]/sso/confirm`)
 * submits the token here. This burns the one-time `jti`, establishes the
 * Better Auth session for the verified `sub`, and redirects (303) to the
 * dashboard with the session cookie(s).
 *
 * CSRF: a session-establishing mutation, so it is gated by the trusted-origin
 * check — a cross-site page cannot auto-submit it on a victim's behalf
 * (defeating the IdP-initiated login-CSRF the GET interstitial guards against,
 * P2-2).
 */
export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request);
  const limited = rateLimitConsume(request, requestId);
  if (limited) return limited;

  const origin = checkTrustedOrigin(request);
  if (!origin.ok) {
    await auditEvent({
      eventType: "sso.consume.failure",
      outcome: "denied",
      reason: origin.reason,
      request,
    });
    return ssoErrorResponse("forbidden", 403, requestId);
  }

  let token: string | null = null;
  try {
    const form = await request.formData();
    const value = form.get("token");
    token = typeof value === "string" ? value : null;
  } catch {
    token = null;
  }
  if (!token) {
    await auditEvent({
      eventType: "sso.consume.failure",
      outcome: "failure",
      reason: "missing_token",
      request,
    });
    return ssoErrorResponse("missing_token", 400, requestId);
  }

  const aud = resolveExpectedAudience(requestId);
  if ("error" in aud) return aud.error;

  try {
    const verified = await verifySsoHandoff({ token, expectedAudience: aud.audience });
    assertTargetApplication(verified.payload, aud.applicationId);
    // Consume the jti atomically BEFORE establishing any session, so a replayed
    // token is rejected even on concurrent requests. The burn is ALSO
    // predicated on this deployment's application id, so a nonce minted for
    // another app can never be spent here (review #15, defence in depth).
    const consumed = await consumeSsoHandoffNonce(verified.payload.jti, aud.applicationId);
    if (!consumed) {
      await auditEvent({
        eventType: "sso.consume.failure",
        outcome: "failure",
        reason: "nonce_replay_or_expired",
        request,
      });
      return ssoErrorResponse("token_already_used", 401, requestId);
    }

    // Establish the consumer-side session. The nonce is already burned, so a
    // failure here cannot be retried with the same token — intentional: a token
    // that reached session establishment was valid, and the failure modes below
    // (banned/unknown user, session store down) all warrant a fresh launch.
    //
    // Headers go through `withTrustedClientIp`: this route is NOT behind the
    // proxy matcher, so the `x-drk-client-ip` header Better Auth reads for
    // `session.ipAddress` must be derived here from the trusted hop — a
    // client replaying the handoff (e.g. curl) could otherwise inject it, and
    // the audit row below (which uses the same `getClientIp` model) would
    // disagree with the session (review #35 / #190).
    let sessionHeaders: Headers;
    try {
      const result = await auth.api.createSsoSession({
        body: { userId: verified.payload.sub },
        headers: withTrustedClientIp(request.headers),
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

    const locale = landingLocale(
      verified.payload.locale,
      request.nextUrl.searchParams.get("locale"),
    );
    const dashboardUrl = new URL(`/${locale}/app/dashboard`, request.url);
    // 303 See Other: turn the POST into a GET of the dashboard.
    const response = new NextResponse(null, { status: 303 });
    response.headers.set("Location", dashboardUrl.toString());
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    response.headers.set(REQUEST_ID_HEADER, requestId);
    // Forward the signed Better Auth session cookie(s). Use getSetCookie():
    // iterating entries() collapses multiple same-name headers into one
    // comma-joined value, corrupting a Set-Cookie when Better Auth emits more
    // than one (e.g. session token + dont_remember) (AUTH-3).
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
