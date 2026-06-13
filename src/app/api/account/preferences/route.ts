import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { isSupportedLocale } from "@/config/i18n-config";
import { isDateFormatOption, isValidTimeZone, normalizeOptional } from "@/lib/account/preferences";

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
 */
const bodySchema = z
  .object({
    preferredLocale: z.string().refine(isSupportedLocale, { message: "unsupported_locale" }),
    timeZone: z.string().max(64).nullable().optional(),
    dateFormat: z.string().refine(isDateFormatOption, { message: "invalid_date_format" }),
    numberFormatLocale: z
      .string()
      .refine((v) => v === "system" || isSupportedLocale(v), { message: "invalid_number_locale" }),
  })
  .strict();

export async function PUT(request: NextRequest) {
  const guard = await requireAccountUser(request);
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const timeZone = normalizeOptional(parsed.data.timeZone);
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    return NextResponse.json({ error: "invalid_time_zone" }, { status: 400 });
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
