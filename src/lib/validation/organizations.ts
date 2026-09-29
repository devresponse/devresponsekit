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
    // Trimmed before the required check, so a name of spaces is empty (F-157).
    name: z.string().trim().min(1, "required").max(200, "max"),
    isDefault: z.boolean().optional(),
  })
  .strict();

export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

/** Organization statuses (matches the DB + PATCH route). */
export const ORGANIZATION_STATUSES = ["active", "pending", "suspended", "archived"] as const;

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/**
 * The ONE organization status under which a membership counts (F-09).
 *
 * `pending`, `suspended` and `archived` all mean "this tenant confers nothing":
 * a membership in such an org resolves as no membership at all
 * (`getUserAccessContext`), so its members, org admins, bound credentials, SSO
 * launches and pending invitations stop working, and a `superuser` grant held
 * there stops making anyone a platform superadmin. The rows are untouched, so
 * reactivating the org restores exactly what was there. Every query that asks
 * "does this membership count" joins `app_organizations` on this value — grep
 * for it to find the family.
 */
export const ACTIVE_ORGANIZATION_STATUS = "active" satisfies OrganizationStatus;

/**
 * The ONE membership status under which a user may RECEIVE a grant in an
 * organization (F-154): a role, a group, or an invitation's role. The server
 * asks `grantEligibleUserIds` (`access-scope.server.ts`), and the user-detail
 * role and group pickers list only the orgs where the target holds a
 * membership of this status, so they offer what the server accepts. It lives
 * here, not in that `server-only` module, so the pickers share the value.
 */
export const GRANT_ELIGIBLE_MEMBERSHIP_STATUS = "active";

/** Partial update contract for `PATCH /api/administrator/organizations/[id]`. */
export const updateOrganizationSchema = z
  .object({
    slug: z.string().min(1, "required").max(64, "max").regex(SLUG_RE, "slug").optional(),
    name: z.string().trim().min(1, "required").max(200, "max").optional(),
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
