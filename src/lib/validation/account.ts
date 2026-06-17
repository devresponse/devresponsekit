import { z } from "zod";
import { isSupportedLocale } from "@/config/i18n-config";
import { isDateFormatOption } from "@/lib/account/preferences";

/**
 * Shared validation schemas for the self-service Account forms
 * (docs/form-validation.md). Imported by both the API routes and the forms so
 * the two enforce identical rules. Error messages are stable `validation.*`
 * i18n keys. (`@/lib/account/preferences` is pure/client-safe, so its
 * validators bundle fine here.)
 */

/** PATCH /api/account/profile — `name` required, display name optional. */
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1, "required").max(120, "max"),
    displayName: z.string().trim().max(120, "max").nullable().optional(),
  })
  .strict();
export type UpdateProfileInput = z.input<typeof updateProfileSchema>;

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
