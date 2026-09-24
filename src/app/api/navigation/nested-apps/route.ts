import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentSession } from "@/lib/auth-guard";
import { noteSessionImpersonation } from "@/lib/impersonation-attribution.server";
import { decideSecureAccess } from "@/lib/auth-status";
import { getSessionAccessContext } from "@/lib/session-access.server";
import { loadNestedAppsMenu } from "@/lib/navigation.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { auditEvent } from "@/lib/audit.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  applicationId: z.string().min(1).max(64),
  locale: z
    .string()
    .optional()
    .transform((v) => (v && isSupportedLocale(v) ? v : defaultLocale)),
});

/**
 * GET /api/navigation/nested-apps
 *
 * MENU #2 — nested workspace selection menu. Same auth contract as the
 * other navigation routes per §23.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // F-07: read directly, not through a guard, so record an impersonation for
  // `auditEvent` here — the denial row below then names the human behind it.
  noteSessionImpersonation(request, session);

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  const access = await getSessionAccessContext(session);
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

  const body = await loadNestedAppsMenu(access, parsed.data.applicationId, parsed.data.locale);
  return NextResponse.json(body, { status: 200 });
});
