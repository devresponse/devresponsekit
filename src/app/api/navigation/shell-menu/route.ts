import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { loadShellMenu } from "@/lib/navigation.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { auditEvent } from "@/lib/audit.server";
// Shared first-party JSON error envelope (P3-12).
import { adminErrorResponse } from "@/lib/admin/errors.server";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  scope: z.string().min(1).max(64),
  locale: z
    .string()
    .optional()
    .transform((v) => (v && isSupportedLocale(v) ? v : defaultLocale)),
});

/**
 * GET /api/navigation/shell-menu
 *
 * Returns the shell sidebar menu for the requested scope, filtered by
 * the caller's permissions. Returns 401/403 per §23 — never redirects.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return adminErrorResponse("unauthenticated", 401, request);
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return adminErrorResponse("invalid_query", 400, request);
  }

  const access = await getUserAccessContext(session.user.id);
  const decision = decideSecureAccess(access.status, access.membershipStatus);
  if (decision !== "allow") {
    await auditEvent({
      eventType: "navigation.menu.denied",
      outcome: "denied",
      actorBetterAuthUserId: session.user.id,
      reason: decision,
      request,
    });
    return adminErrorResponse("forbidden", 403, request);
  }

  const body = await loadShellMenu(access, parsed.data.scope, parsed.data.locale);
  return NextResponse.json(body, { status: 200 });
}
