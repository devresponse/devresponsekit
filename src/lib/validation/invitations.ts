import { z } from "zod";

/**
 * Shared validation for organization invitations (0008). Imported by BOTH
 * the API routes and the client forms so the two enforce identical rules.
 * Error messages are stable `validation.*` i18n keys.
 */

export const createInvitationSchema = z
  .object({
    // Trim BEFORE the email check so a pasted address with padding passes;
    // the server lowercases on top of this.
    email: z.string().trim().min(1, "required").max(320, "max").email("email"),
    roleId: z.string().uuid("uuid").nullable().optional(),
  })
  .strict();

export type CreateInvitationInput = z.input<typeof createInvitationSchema>;

/** Plaintext accept secrets are 32 base62 chars; allow headroom, never blank. */
export const acceptInvitationSchema = z
  .object({
    token: z.string().min(1, "required").max(128, "max"),
  })
  .strict();

export type AcceptInvitationInput = z.input<typeof acceptInvitationSchema>;
