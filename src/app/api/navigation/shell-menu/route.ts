import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { loadShellMenu } from "@/lib/navigation.server";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { auditEvent } from "@/lib/audit.server";

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
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
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

  const body = await loadShellMenu(access, parsed.data.scope, parsed.data.locale);
  return NextResponse.json(body, { status: 200 });
}
