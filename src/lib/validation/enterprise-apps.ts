import { z } from "zod";
import {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
} from "@/lib/admin/enterprise-apps";
import { UUID_RE } from "@/lib/uuid";

/**
 * Shared validation schema for creating an enterprise application. Imported by
 * BOTH the API route (`POST /api/administrator/enterprise-apps`) and the client
 * form so the two enforce identical rules. Error messages are stable
 * `validation.*` i18n keys.
 *
 * The regex/enum primitives come from the client-safe `@/lib/admin/enterprise-apps`
 * (the `.server` module is only a re-export shim). `origin` is only length-bounded
 * here; the HTTPS + trusted-suffix checks stay in the route (server-only env) and
 * surface as `invalid_origin` / `origin_not_allowed`, which the form maps onto the
 * origin field. Likewise `sso_audience` is only shape-checked here — its
 * catalog-wide uniqueness needs the database and is enforced by the routes
 * (`409 audience_taken`, review #15).
 */
export const createEnterpriseAppSchema = z
  .object({
    id: z.string().min(1, "required").max(128, "max").regex(APP_ID_RE, "appId"),
    // Trimmed before the required check, so a label of spaces is empty (F-157).
    label: z.string().trim().min(1, "required").max(200, "max"),
    description: z.string().max(1000, "max").nullable().optional(),
    origin: z.string().min(1, "required").max(500, "max"),
    subdomain: z.string().min(1, "required").max(63, "max").regex(SUBDOMAIN_RE, "subdomain"),
    sso_audience: z
      .string()
      .min(1, "required")
      .max(200, "max")
      .regex(SSO_AUDIENCE_RE, "ssoAudience"),
    status: z.enum(APP_STATUS_VALUES).optional(),
    sort_order: z.number("number").int("number").min(0, "number").max(10000, "max").optional(),
    organization_id: z.string().regex(UUID_RE, "uuid").nullable().optional(),
  })
  .strict();

export type CreateEnterpriseAppInput = z.input<typeof createEnterpriseAppSchema>;

/**
 * The body the Administrator → Enterprise apps → New form POSTs: its values
 * trimmed, an empty description as `null`, and always an `organization_id`
 * (`null` = a global app). The form used to leave that out, so every create was
 * a global app and an org admin's was refused with 403 (R14). Shared so the
 * route suites post exactly what the form sends.
 */
export function createEnterpriseAppRequestBody(
  values: CreateEnterpriseAppInput,
): CreateEnterpriseAppInput {
  return {
    id: values.id.trim(),
    label: values.label.trim(),
    description: values.description?.trim() ? values.description.trim() : null,
    origin: values.origin.trim(),
    subdomain: values.subdomain.trim(),
    sso_audience: values.sso_audience.trim(),
    sort_order: values.sort_order,
    organization_id: values.organization_id ?? null,
  };
}

/**
 * Partial update contract for `PATCH /api/administrator/enterprise-apps/[id]`
 * — the `id` is immutable, every other field optional. (HTTPS/trusted-suffix
 * origin checks stay in the route.)
 */
export const updateEnterpriseAppSchema = z
  .object({
    label: z.string().trim().min(1, "required").max(200, "max").optional(),
    description: z.string().max(1000, "max").nullable().optional(),
    origin: z.string().min(1, "required").max(500, "max").optional(),
    subdomain: z
      .string()
      .min(1, "required")
      .max(63, "max")
      .regex(SUBDOMAIN_RE, "subdomain")
      .optional(),
    sso_audience: z
      .string()
      .min(1, "required")
      .max(200, "max")
      .regex(SSO_AUDIENCE_RE, "ssoAudience")
      .optional(),
    status: z.enum(APP_STATUS_VALUES).optional(),
    sort_order: z.number("number").int("number").min(0, "number").max(10000, "max").optional(),
    organization_id: z.string().regex(UUID_RE, "uuid").nullable().optional(),
  })
  .strict();

/** Enterprise-app settings form view: the create-required fields stay required. */
export const enterpriseAppSettingsSchema = updateEnterpriseAppSchema.required({
  label: true,
  origin: true,
  subdomain: true,
  sso_audience: true,
});
export type EnterpriseAppSettingsInput = z.input<typeof enterpriseAppSettingsSchema>;
