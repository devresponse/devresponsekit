import { z } from "zod";
import { isSupportedLocale } from "@/config/i18n-config";
import { optionalUserNameSchema } from "@/lib/user-name";

/**
 * The ONE schema every `preferredLocale` WRITE path must use (review #71/#80).
 *
 * `preferred_locale` is a plain `text` column with no CHECK constraint, and
 * the admin/v1 write paths used to accept any 2-10 character string. An
 * unsupported value is not inert: next-intl falls back to the default catalog
 * at render, but the stored value keeps flowing into email-template selection
 * and SSO handoffs, so "fr-CA" or "xx" silently degrades those surfaces with
 * no error anywhere. Constraining the write closes the hole at the only place
 * that can distinguish a typo from a deliberate value.
 *
 * The self-service routes (`/api/preferences/locale`, `/api/account/
 * preferences`) already refine against `isSupportedLocale`; this shares the
 * SAME predicate and the same `locales` array from `@/config/i18n-config`, so
 * adding a locale there widens every write path at once and nothing can drift.
 *
 * READS stay tolerant on purpose: rows written before this constraint (or by
 * a direct SQL edit) may still hold an unsupported value. We do NOT migrate or
 * reject them — `getUserAccessContext` / next-intl already fall back to
 * `defaultLocale` when the stored value is not supported, so an old row keeps
 * rendering; it simply cannot be re-saved as-is. See docs/configuration.md.
 *
 * The error message is the stable `validation.*` i18n key convention used by
 * the rest of this module.
 */
export const preferredLocaleSchema = z
  .string()
  .refine((value) => isSupportedLocale(value), "unsupportedLocale");

/**
 * Shared validation schema for creating an application user. Imported by BOTH
 * the API route (`POST /api/administrator/users`) and the client form so the
 * two enforce identical rules (single source of truth).
 *
 * Error messages are stable `validation.*` i18n keys (not prose): the client's
 * `FormMessage` localizes them at render; the server only checks pass/fail, so
 * the keys never reach an end user untranslated.
 */
export const createUserSchema = z
  .object({
    email: z.email("email"),
    password: z.string().min(8, "passwordMin").max(128, "passwordMax"),
    // Display name is optional; an empty value is treated as "no name".
    // Otherwise the shared name rule applies (F-21, `user-name.ts`).
    name: optionalUserNameSchema.optional(),
    role: z.enum(["admin", "user"]).optional(),
    initialAppStatus: z.enum(["active", "pending_approval"]).optional().default("pending_approval"),
    preferredLocale: preferredLocaleSchema.optional(),
  })
  .strict();

/** Form value type (input side — defaults/optionals not yet applied). */
export type CreateUserInput = z.input<typeof createUserSchema>;
