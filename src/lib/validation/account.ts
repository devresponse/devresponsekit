import { z } from "zod";
import { isSupportedLocale } from "@/config/i18n-config";
import { isDateFormatOption } from "@/lib/account/preferences";
import { optionalUserNameSchema, userNameSchema } from "@/lib/user-name";

/**
 * Shared validation schemas for the self-service Account forms
 * (docs/form-validation.md). Imported by both the API routes and the forms so
 * the two enforce identical rules. Error messages are stable `validation.*`
 * i18n keys. (`@/lib/account/preferences` is pure/client-safe, so its
 * validators bundle fine here.)
 */

/**
 * PATCH /api/account/profile — `name` required, display name optional.
 *
 * `displayName` is `.nullable().optional()` and that distinction is
 * LOAD-BEARING (review #187): PATCH is a partial update, so
 *
 *   - key ABSENT       → leave `display_name` exactly as it is,
 *   - `displayName: null` → clear it,
 *   - `displayName: "…"`  → set it.
 *
 * Zod (v4, like v3) does not materialize an absent optional key on the parsed
 * object, so `"displayName" in parsed.data` is the discriminator between the
 * first two cases — `parsed.data.displayName ?? null` collapses them and turns
 * every `{ name }`-only PATCH into a silent data loss. `hasDisplayName` below
 * is the ONLY sanctioned way to ask; pinned by tests/unit/account-profile-*.
 */
export const updateProfileSchema = z
  .object({
    // F-21: both follow the shared name rule (`user-name.ts`). `name` is the
    // Better Auth name the sign-up form set, so it shares that form's bound
    // (it was 120 here, which refused to re-save a 121-200 character name the
    // sign-up had accepted). `displayName` is quoted by the invitation email
    // (`inviterName`), so control and bidi characters are refused there too;
    // blank still means "no display name".
    name: userNameSchema,
    displayName: optionalUserNameSchema.nullable().optional(),
  })
  .strict();
export type UpdateProfileInput = z.input<typeof updateProfileSchema>;

/** True only when the caller actually sent `displayName` (review #187). */
export function hasDisplayName(
  parsed: z.output<typeof updateProfileSchema>,
): parsed is z.output<typeof updateProfileSchema> & { displayName: string | null } {
  return Object.prototype.hasOwnProperty.call(parsed, "displayName");
}

/** PUT /api/account/preferences — locale/date/number are constrained choices. */
export const updatePreferencesSchema = z
  .object({
    preferredLocale: z.string().refine(isSupportedLocale, "locale"),
    timeZone: z.string().max(64, "max").nullable().optional(),
    dateFormat: z.string().refine(isDateFormatOption, "dateFormat"),
    numberFormatLocale: z.string().refine((v) => v === "system" || isSupportedLocale(v), "locale"),
  })
  .strict();
export type UpdatePreferencesInput = z.input<typeof updatePreferencesSchema>;

/**
 * Change-password form view (Better Auth performs the actual change, so there
 * is no route schema). The base object drives the required markers; the
 * refined schema adds the new/confirm match check (surfaced on confirm).
 */
export const passwordFieldsSchema = z.object({
  currentPassword: z.string().min(1, "required"),
  newPassword: z.string().min(8, "passwordMin").max(128, "passwordMax"),
  confirmPassword: z.string().min(1, "required"),
});
export const changePasswordSchema = passwordFieldsSchema.refine(
  (d) => d.newPassword === d.confirmPassword,
  { message: "passwordsMismatch", path: ["confirmPassword"] },
);
export type ChangePasswordInput = z.input<typeof passwordFieldsSchema>;
