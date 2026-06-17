import { z } from "zod";

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
    name: z.string().max(200, "max").optional(),
    role: z.enum(["admin", "user"]).optional(),
    initialAppStatus: z.enum(["active", "pending_approval"]).optional().default("pending_approval"),
    preferredLocale: z.string().min(2).max(10).optional(),
  })
  .strict();

/** Form value type (input side — defaults/optionals not yet applied). */
export type CreateUserInput = z.input<typeof createUserSchema>;
