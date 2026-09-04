import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { isValidTimeZone, normalizeOptional } from "@/lib/account/preferences";
import { updatePreferencesSchema } from "@/lib/validation/account";
// Shared first-party JSON error envelope (P3-12).
import { adminErrorResponse } from "@/lib/admin/errors.server";

export const dynamic = "force-dynamic";

/**
 * PUT /api/account/preferences
 *
 * Updates the CALLER'S OWN locale and formatting preferences. Scoped
 * strictly to `actor.appUserId`; no id is accepted from the client. The
 * preferred locale is mirrored onto `app_users.preferred_locale` (which
 * drives the request locale) and the `app_user_locale_preferences` row,
 * matching the existing `/api/preferences/locale` upsert.
 *
 * Validation mirrors `src/lib/account/preferences.ts`: locale against the
 * supported allow-list, time zone against the runtime Intl engine, date
 * format against the fixed option set, number-format locale against the
 * supported locales (or "system" → NULL).
 *
 * A bearer credential must carry `account.preferences.write` (design §7);
 * a read-only or zero-scope key is refused with 403 `insufficient_scope`.
 * Cookie sessions carry full user authority and pass (review #184).
 */

export async function PUT(request: NextRequest) {
  const guard = await requireAccountUser(request, "account.preferences.write");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updatePreferencesSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const timeZone = normalizeOptional(parsed.data.timeZone);
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    return adminErrorResponse("invalid_time_zone", 400, request);
  }
  const dateFormat = parsed.data.dateFormat === "system" ? null : parsed.data.dateFormat;
  const numberFormatLocale = normalizeOptional(parsed.data.numberFormatLocale);

  // Mirror the preferred locale onto app_users (drives request locale).
  await db
    .updateTable("app_users")
    .set({ preferred_locale: parsed.data.preferredLocale, updated_at: sql`now()` })
    .where("id", "=", actor.appUserId)
    .execute();

  await db
    .insertInto("app_user_locale_preferences")
    .values({
      app_user_id: actor.appUserId,
      locale: parsed.data.preferredLocale,
      time_zone: timeZone,
      date_format: dateFormat,
      number_format_locale: numberFormatLocale,
    })
    .onConflict((oc) =>
      oc.column("app_user_id").doUpdateSet({
        locale: parsed.data.preferredLocale,
        time_zone: timeZone,
        date_format: dateFormat,
        number_format_locale: numberFormatLocale,
        updated_at: sql`now()`,
      }),
    )
    .execute();

  await auditEvent({
    eventType: "account.preferences.updated",
    outcome: "success",
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    request,
    metadata: { locale: parsed.data.preferredLocale },
  });

  return NextResponse.json({ ok: true });
}
