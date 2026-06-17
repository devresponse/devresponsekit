import { z } from "zod";

/**
 * Shared validation schema for creating an organization. Imported by BOTH the
 * API route (`POST /api/administrator/organizations`) and the client form so
 * the two enforce identical rules. Error messages are stable `validation.*`
 * i18n keys.
 *
 * `SLUG_RE` is duplicated here (rather than imported from `orgs.server`)
 * because this module is bundled to the client and `orgs.server` is
 * `server-only`. The pattern is the canonical org slug: 1–64 chars, lowercase
 * alphanumerics and hyphens, not starting/ending with a hyphen.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const createOrganizationSchema = z
  .object({
    slug: z.string().min(1, "required").max(64, "max").regex(SLUG_RE, "slug"),
    name: z.string().min(1, "required").max(200, "max"),
    isDefault: z.boolean().optional(),
  })
  .strict();

export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

/** Organization statuses (matches the DB + PATCH route). */
export const ORGANIZATION_STATUSES = ["active", "pending", "suspended", "archived"] as const;

/** Partial update contract for `PATCH /api/administrator/organizations/[id]`. */
export const updateOrganizationSchema = z
  .object({
    slug: z.string().min(1, "required").max(64, "max").regex(SLUG_RE, "slug").optional(),
    name: z.string().min(1, "required").max(200, "max").optional(),
    status: z.enum(ORGANIZATION_STATUSES).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

/** Org settings form view: slug + name required, status/isDefault optional. */
export const organizationSettingsSchema = updateOrganizationSchema.required({
  slug: true,
  name: true,
});
export type OrganizationSettingsInput = z.input<typeof organizationSettingsSchema>;
