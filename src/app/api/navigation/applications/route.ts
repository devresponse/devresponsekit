import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { loadApplicationsMenu } from "@/lib/navigation.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { auditEvent } from "@/lib/audit.server";

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
 *   - Never redirects (per §23). UI handles the error envelope.
 *   - Items are filtered server-side; never returns SSO tokens.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const queryRaw = Object.fromEntries(request.nextUrl.searchParams.entries());
  const queryParsed = querySchema.safeParse(queryRaw);
  if (!queryParsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
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
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await loadApplicationsMenu(access, queryParsed.data.locale);
  return NextResponse.json(body, { status: 200 });
}
