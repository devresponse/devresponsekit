import { NextResponse, type NextRequest } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { isSupportedLocale, locales } from "@/config/i18n-config";
// Shared first-party JSON error envelope (P3-12).
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  locale: z.string().refine((v) => isSupportedLocale(v), { message: "unsupported_locale" }),
});

/**
 * POST /api/preferences/locale
 *
 * Persists the authenticated user's preferred locale. The locale value
 * is validated against the configured allow-list to prevent arbitrary
 * cookie/string injection. Successful changes are audit-logged as
 * `i18n.locale.changed` per §15.6.
 *
 * Cookie-session mutation ⇒ trusted-origin CSRF guard first, exactly like
 * the account/administrator mutation guards (review #39/#188). The route
 * authenticates only via the session cookie, so the guard is unconditional.
 * Pending users may still set their locale once the origin is trusted.
 */
export async function POST(request: NextRequest) {
  const origin = checkTrustedOrigin(request);
  if (!origin.ok) {
    return adminErrorResponse("untrusted_origin", 403, request);
  }

  const session = await getCurrentSession();
  if (!session) {
    return adminErrorResponse("unauthenticated", 401, request);
  }

  const access = await getUserAccessContext(session.user.id);
  // Even pending users may set their preferred locale.
  if (decideSecureAccess(access.status, access.membershipStatus) === "blocked") {
    return adminErrorResponse("forbidden", 403, request);
  }
  if (!access.appUserId) {
    return adminErrorResponse("not_provisioned", 403, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_locale", 400, request, { extra: { allowed: locales } });
  }

  await db
    .updateTable("app_users")
    .set({ preferred_locale: parsed.data.locale, updated_at: sql`now()` })
    .where("id", "=", access.appUserId)
    .execute();

  await db
    .insertInto("app_user_locale_preferences")
    .values({
      app_user_id: access.appUserId,
      locale: parsed.data.locale,
    })
    .onConflict((oc) =>
      oc.column("app_user_id").doUpdateSet({
        locale: parsed.data.locale,
        updated_at: sql`now()`,
      }),
    )
    .execute();

  await auditEvent({
    eventType: "i18n.locale.changed",
    outcome: "success",
    actorBetterAuthUserId: session.user.id,
    appUserId: access.appUserId,
    request,
    metadata: { locale: parsed.data.locale },
  });

  return NextResponse.json({ ok: true, locale: parsed.data.locale });
}
