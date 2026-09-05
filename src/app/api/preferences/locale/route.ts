import { NextResponse, type NextRequest } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { isSupportedLocale, locales } from "@/config/i18n-config";
// Shared first-party JSON error envelope (P3-12).
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";

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
 * Authorization goes through the shared self-service guard
 * (`requireAccountUser`, review #28) — the SAME gate as `/api/account/*`:
 * trusted-origin CSRF check on ambient cookies (review #39/#188), active
 * user + active membership, and the `account.preferences.write` scope for a
 * bearer credential. The only client that persists a locale is the secure
 * shell's switcher (an active member by construction), so the guard's
 * active-member requirement changes nothing for real traffic. The write is
 * scoped strictly to `actor.appUserId`; no id is accepted from the body.
 *
 * Rate-limited per user on the mutation tier so a scripted loop cannot spam
 * `app_audit_events` (review #28 — one bucket shape for every first-party
 * cookie mutation).
 */
export async function POST(request: NextRequest) {
  const guard = await requireAccountUser(request, "account.preferences.write");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  const requestId = getOrCreateRequestId(request);
  const limited = enforceRateLimit(
    "preferences.locale",
    actor.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    requestId,
  );
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_locale", 400, request, {
      requestId,
      extra: { allowed: locales },
    });
  }

  await db
    .updateTable("app_users")
    .set({ preferred_locale: parsed.data.locale, updated_at: sql`now()` })
    .where("id", "=", actor.appUserId)
    .execute();

  await db
    .insertInto("app_user_locale_preferences")
    .values({
      app_user_id: actor.appUserId,
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
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    request,
    requestId,
    metadata: { locale: parsed.data.locale },
  });

  return NextResponse.json({ ok: true, locale: parsed.data.locale });
}
