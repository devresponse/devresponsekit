import "server-only";
import { db } from "@/db/database";
import { isOrgNamespacedAppId, isOrgNamespacedAudience } from "./enterprise-apps";

/** A catalog field whose value is a platform-global name. */
export type AppNameField = "id" | "sso_audience";

/**
 * I-01 — AN ORG ADMIN NAMES ITS APPS UNDER ITS ORG'S SLUG.
 *
 * `app_enterprise_applications.id` (the primary key) and `sso_audience` (the
 * UNIQUE index of migration 0005, review #15) are global namespaces. An org
 * admin could register an app in its own org under a conventional name such as
 * `crm` or `devresponse-app:crm`, and the superadmin who later registers the
 * real satellite got `409 id_taken` / `audience_taken` and had to rename it,
 * along with the satellite's `SSO_HANDOFF_APPLICATION_ID`. So a caller without
 * cross-org reach may claim only names in its org's namespace
 * (`isOrgNamespacedAppId`, `isOrgNamespacedAudience`); any other name is the
 * platform's, and the routes refuse it as a superadmin-only action. The
 * routes ask `hasCrossOrgReach` themselves before calling this.
 *
 * Returns the fields of `names` whose value lies outside the namespace of
 * `organizationId`, so empty when the caller may claim them all. With no org
 * row there is no namespace, and every field named is outside it.
 */
export async function appNamesOutsideOrgNamespace(
  organizationId: string,
  names: { id?: string; sso_audience?: string },
): Promise<AppNameField[]> {
  const org = await db
    .selectFrom("app_organizations")
    .select(["slug"])
    .where("id", "=", organizationId)
    .executeTakeFirst();
  const slug = org?.slug;
  const outside: AppNameField[] = [];
  if (names.id !== undefined && !(slug && isOrgNamespacedAppId(names.id, slug))) {
    outside.push("id");
  }
  if (
    names.sso_audience !== undefined &&
    !(slug && isOrgNamespacedAudience(names.sso_audience, slug))
  ) {
    outside.push("sso_audience");
  }
  return outside;
}
