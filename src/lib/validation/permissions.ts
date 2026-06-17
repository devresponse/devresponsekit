import { z } from "zod";

/**
 * Shared validation schema for creating a permission. Imported by BOTH the API
 * route (`POST /api/administrator/permissions`) and the client form so the two
 * enforce identical rules. Error messages are stable `validation.*` i18n keys.
 */
export const PERMISSION_KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;

export const createPermissionSchema = z
  .object({
    key: z.string().min(1, "required").max(120, "max").regex(PERMISSION_KEY_RE, "key"),
    description: z.string().max(1000, "max").optional(),
  })
  .strict();

export type CreatePermissionInput = z.input<typeof createPermissionSchema>;
