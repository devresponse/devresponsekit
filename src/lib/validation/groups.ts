import { z } from "zod";

/**
 * Shared validation schema for creating a group. Imported by BOTH the API
 * route (`POST /api/administrator/groups`) and the client form so the two
 * enforce identical rules. Error messages are stable `validation.*` i18n keys.
 *
 * Groups are ALWAYS tenant-scoped: `organizationId` is optional here because an
 * org admin omits it (the server forces their own org); a SUPERADMIN must pick
 * one — enforced in the form, since "global" is not a valid group scope.
 */
export const GROUP_KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createGroupSchema = z
  .object({
    key: z.string().min(1, "required").max(120, "max").regex(GROUP_KEY_RE, "key"),
    name: z.string().min(1, "required").max(200, "max"),
    description: z.string().max(1000, "max").optional(),
    organizationId: z.string().regex(UUID_RE, "uuid").optional(),
  })
  .strict();

export type CreateGroupInput = z.input<typeof createGroupSchema>;
