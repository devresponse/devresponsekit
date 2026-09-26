import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { updateEmailTemplateSchema } from "@/lib/validation/email-templates";
import {
  createEnterpriseAppSchema,
  enterpriseAppSettingsSchema,
  updateEnterpriseAppSchema,
} from "@/lib/validation/enterprise-apps";
import { createGroupSchema, groupSettingsSchema, updateGroupSchema } from "@/lib/validation/groups";
import {
  createOrganizationSchema,
  organizationSettingsSchema,
  updateOrganizationSchema,
} from "@/lib/validation/organizations";
import { createRoleSchema, roleSettingsSchema, updateRoleSchema } from "@/lib/validation/roles";

/**
 * F-157: a resource's display name is trimmed BEFORE its required check.
 *
 * The shared schemas checked `.min(1)` on the raw value and the forms trimmed
 * only after validating, so a name of spaces passed the form and came back
 * from the server as a banner ("Select an organization for this group." on
 * New group; "The submitted data is invalid." on the settings tabs), and a
 * script calling `PATCH /api/administrator/roles/{id}` with `{"name":"   "}`
 * stored a blank-looking role name, since no route trims either. Each schema
 * below is the one its form AND its route parse with, so pinning the schema
 * pins both.
 */
interface Case {
  name: string;
  schema: ZodType;
  /** The other fields the schema requires, valid. */
  rest: Record<string, unknown>;
  field: string;
}

const APP = { origin: "https://crm.example.com", subdomain: "crm", sso_audience: "crm" };
const CASES: Case[] = [
  { name: "createRoleSchema", schema: createRoleSchema, rest: { key: "ops" }, field: "name" },
  { name: "updateRoleSchema", schema: updateRoleSchema, rest: {}, field: "name" },
  { name: "roleSettingsSchema", schema: roleSettingsSchema, rest: {}, field: "name" },
  { name: "createGroupSchema", schema: createGroupSchema, rest: { key: "ops" }, field: "name" },
  { name: "updateGroupSchema", schema: updateGroupSchema, rest: {}, field: "name" },
  { name: "groupSettingsSchema", schema: groupSettingsSchema, rest: {}, field: "name" },
  {
    name: "createOrganizationSchema",
    schema: createOrganizationSchema,
    rest: { slug: "acme" },
    field: "name",
  },
  { name: "updateOrganizationSchema", schema: updateOrganizationSchema, rest: {}, field: "name" },
  {
    name: "organizationSettingsSchema",
    schema: organizationSettingsSchema,
    rest: { slug: "acme" },
    field: "name",
  },
  {
    name: "createEnterpriseAppSchema",
    schema: createEnterpriseAppSchema,
    rest: { id: "crm", ...APP },
    field: "label",
  },
  {
    name: "updateEnterpriseAppSchema",
    schema: updateEnterpriseAppSchema,
    rest: {},
    field: "label",
  },
  {
    name: "enterpriseAppSettingsSchema",
    schema: enterpriseAppSettingsSchema,
    rest: APP,
    field: "label",
  },
  {
    name: "updateEmailTemplateSchema",
    schema: updateEmailTemplateSchema,
    rest: { body_html: "<p>Hi</p>" },
    field: "subject",
  },
];

describe("F-157: display names are trimmed before the required check", () => {
  it.each(CASES)(
    "$name refuses a whitespace-only $field as required",
    ({ schema, rest, field }) => {
      for (const blank of ["   ", "\t \n", "\u00a0"]) {
        const result = schema.safeParse({ ...rest, [field]: blank });
        expect(result.success, JSON.stringify(blank)).toBe(false);
        const issues = result.success ? [] : result.error.issues;
        expect(issues.map((i) => [i.path.join("."), i.message])).toEqual([[field, "required"]]);
      }
    },
  );

  it.each(CASES)("$name stores the trimmed $field", ({ schema, rest, field }) => {
    const parsed = schema.parse({ ...rest, [field]: "  Operations  " }) as Record<string, unknown>;
    expect(parsed[field]).toBe("Operations");
  });

  it("leaves the template bodies untouched: their whitespace is the template's", () => {
    const parsed = updateEmailTemplateSchema.parse({
      subject: "Hi",
      body_html: "  <p>Hi</p>\n",
      body_text: "  Hi\n",
    });
    expect(parsed.body_html).toBe("  <p>Hi</p>\n");
    expect(parsed.body_text).toBe("  Hi\n");
  });
});
