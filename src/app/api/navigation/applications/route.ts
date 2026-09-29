import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentSession } from "@/lib/auth-guard";
import { noteSessionImpersonation } from "@/lib/impersonation-attribution.server";
import { decideSecureAccess } from "@/lib/auth-status";
import { getSessionAccessContext } from "@/lib/session-access.server";
import { loadApplicationsMenu } from "@/lib/navigation.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { shouldAuditDenial } from "@/lib/admin/rate-limit.server";
import { auditEvent } from "@/lib/audit.server";
// Shared first-party JSON error envelope (P3-12, F-129), as the shell menu uses.
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  locale: z
    .string()
    .optional()
    .transform((v) => (v && isSupportedLocale(v) ? v : defaultLocale)),
});

/**
 * GET /api/navigation/applications
 *
 * MENU #1 — application switcher menu.
 *
 * Threat / contract:
 *   - 401 for unauthenticated callers, 403 for blocked / pending users.
 *   - Never redirects (per §23). UI handles the error envelope, the shared
 *     `{ error, message, requestId }` one (F-129): these three answers were a
 *     bare `{ error }`, so the 403's `navigation.menu.denied` row carried an
 *     id the caller never saw in the body.
 *   - Items are filtered server-side; never returns SSO tokens.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return adminErrorResponse("unauthenticated", 401, request);
  }
  // F-07: read directly, not through a guard, so record an impersonation for
  // `auditEvent` here — the denial row below then names the human behind it.
  noteSessionImpersonation(request, session);

  const queryRaw = Object.fromEntries(request.nextUrl.searchParams.entries());
  const queryParsed = querySchema.safeParse(queryRaw);
  if (!queryParsed.success) {
    return adminErrorResponse("invalid_query", 400, request);
  }

  const access = await getSessionAccessContext(session);
  const decision = decideSecureAccess(access.status, access.membershipStatus);
  if (decision !== "allow") {
    // F-105: the row is sampled per actor (≈once a minute) so a blocked or
    // pending session cannot write one per GET; the 403 is unconditional.
    if (shouldAuditDenial("navigation.menu", session.user.id)) {
      await auditEvent({
        eventType: "navigation.menu.denied",
        outcome: "denied",
        actorBetterAuthUserId: session.user.id,
        reason: decision,
        request,
      });
    }
    return adminErrorResponse("forbidden", 403, request);
  }

  const body = await loadApplicationsMenu(access, queryParsed.data.locale);
  return NextResponse.json(body, { status: 200 });
});
