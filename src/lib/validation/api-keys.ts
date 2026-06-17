import { z } from "zod";

/**
 * Shared validation schema for issuing an API key on behalf of a user.
 * Imported by BOTH the API route (`POST /api/administrator/api-keys`) and the
 * client form so the two enforce identical rules. Error messages are stable
 * `validation.*` i18n keys.
 *
 * The OWNER's authority over the requested `scopes`, and the owner's existence
 * /active status, are validated server-side (they require DB lookups) and come
 * back as `404` / `409` / `422`, which the form maps onto the relevant field.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1, "required").max(120, "max"),
    ownerAppUserId: z.string().regex(UUID_RE, "uuid"),
    scopes: z.array(z.string().min(1).max(120)).max(64).default([]),
    expiresInDays: z.number("number").int("number").positive("number").max(3650, "max").optional(),
  })
  .strict();

export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;
