import { z } from "zod";
import { UUID_RE } from "@/lib/uuid";

/**
 * Shared validation schema for creating a role. Imported by BOTH the API route
 * (`POST /api/administrator/roles`) and the client form so the two enforce
 * identical rules. Error messages are stable `validation.*` i18n keys.
 */
export const ROLE_KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;

export const createRoleSchema = z
  .object({
    key: z.string().min(1, "required").max(120, "max").regex(ROLE_KEY_RE, "key"),
    // Trimmed BEFORE the required check (F-157): the forms trimmed only after
    // validating, so a name of spaces passed the form, and the server, which
    // did not trim at all, stored a blank-looking role name.
    name: z.string().trim().min(1, "required").max(200, "max"),
    description: z.string().max(1000, "max").optional(),
    organizationId: z.string().regex(UUID_RE, "uuid").nullable().optional(),
  })
  .strict();

export type CreateRoleInput = z.input<typeof createRoleSchema>;

/**
 * Partial update contract for `PATCH /api/administrator/roles/[id]` — every
 * field optional (the key is immutable and not editable). The settings FORM
 * derives a stricter view from this (name required) so field rules stay
 * single-sourced.
 */
export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1, "required").max(200, "max").optional(),
    description: z.string().max(1000, "max").nullable().optional(),
  })
  .strict();

/** Role settings form view: name is required (full edit), description optional. */
export const roleSettingsSchema = updateRoleSchema.required({ name: true });
export type RoleSettingsInput = z.input<typeof roleSettingsSchema>;
