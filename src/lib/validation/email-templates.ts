import { z } from "zod";

/**
 * Shared validation schema for editing an email template. Imported by BOTH the
 * API route (`PUT /api/administrator/email/templates/[id]`) and the client
 * editor so the two enforce identical rules. Error messages are stable
 * `validation.*` i18n keys.
 *
 * Templates are seeded, not created, so this is the only schema — a full edit
 * where subject + HTML body are required; the text body and description are
 * optional.
 */
export const updateEmailTemplateSchema = z
  .object({
    subject: z.string().min(1, "required").max(500, "max"),
    body_html: z.string().min(1, "required").max(100_000, "max"),
    body_text: z.string().max(100_000, "max").nullable().optional(),
    description: z.string().max(1000, "max").nullable().optional(),
  })
  .strict();

export type UpdateEmailTemplateInput = z.input<typeof updateEmailTemplateSchema>;
