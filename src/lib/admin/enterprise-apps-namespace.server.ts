import "server-only";
import { db } from "@/db/database";
import { isOrgNamespacedAppId } from "./enterprise-apps";

/**
 * I-01 — AN ORG ADMIN NAMES ITS APPS UNDER ITS ORG'S SLUG.
 *
 * `app_enterprise_applications.id` (the primary key) and `sso_audience` (the
 * UNIQUE index of migration 0005, review #15) are global namespaces. An org
 * admin could register an app in its own org under a conventional name such as
 * `crm` or `devresponse-app:crm`, and the superadmin who later registers the
 * real satellite got `409 id_taken` / `audience_taken` and had to rename it,
 * along with the satellite's `SSO_HANDOFF_APPLICATION_ID`. So a caller without
 * cross-org reach may claim only ids in its org's namespace
 * (`isOrgNamespacedAppId`); any other id is the platform's, and the routes
 * refuse it as a superadmin-only action. The routes ask `hasCrossOrgReach`
 * themselves before calling this.
 *
 * The audience needs no namespace of its own: such a caller must give it the
 * form `<prefix>:<app id>` (`isConsumableAudienceFor`, R15), so an audience is
 * in the namespace exactly when its app's id is.
 *
 * True when `id` lies in the namespace of `organizationId`. With no org row
 * there is no namespace, and no id lies in it.
 */
export async function isAppIdInOrgNamespace(organizationId: string, id: string): Promise<boolean> {
  const org = await db
    .selectFrom("app_organizations")
    .select(["slug"])
    .where("id", "=", organizationId)
    .executeTakeFirst();
  return org?.slug ? isOrgNamespacedAppId(id, org.slug) : false;
}
