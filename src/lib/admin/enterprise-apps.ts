/**
 * Validators for the enterprise-apps endpoints (docs/admin-manager.md
 * §8.7).
 *
 * Extracted to a non-`server-only` module so it can be imported by both
 * the runtime route handlers (`enterprise-apps.server.ts`) AND by the
 * client forms which run in the browser bundle and cannot resolve the
 * `server-only` import sentinel.
 *
 * This module MUST stay free of side effects and runtime imports — it
 * only exports static data and pure helpers.
 */

/**
 * Hostname-safe subdomain: lowercase letters, digits and hyphens, not
 * starting or ending with a hyphen, 1–63 characters (DNS label limit).
 */
export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Application id: lowercase letters, digits, dot, underscore and
 * hyphen, 1–128 characters. Application ids are text primary keys
 * and are referenced by SSO handoff nonces, so they must be stable
 * once chosen.
 */
export const APP_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;

/**
 * SSO audience identifier; `audience-prefix:app-id` style. Accepts the
 * same character class as the app id but allows ASCII colons so the
 * conventional `prefix:suffix` shape works. 1–200 characters.
 */
export const SSO_AUDIENCE_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,199})$/;

/**
 * I-01: true when `id` lies in the namespace of the organization whose slug is
 * `orgSlug`: the slug, a dot, and at least one more character (`acme.crm`).
 *
 * App ids and audiences are platform-global (a primary key and a UNIQUE
 * index), so a name an org admin registers is a name no one else can have. A
 * caller without cross-org reach may claim only names under its own org's
 * slug, which only a superadmin assigns; every other name stays the
 * platform's. The separator is a dot because an org slug (`SLUG_RE`) never
 * contains one: with a hyphen, org `acme` would own `acme-corp-crm`, a name in
 * the namespace of org `acme-corp`.
 */
export function isOrgNamespacedAppId(id: string, orgSlug: string): boolean {
  const namespace = `${orgSlug}.`;
  return id.length > namespace.length && id.startsWith(namespace);
}

/**
 * The `SSO_HANDOFF_AUDIENCE_PREFIX` a kit satellite runs with unless it sets
 * another (`.env.example`, drk-deploy's `--audience-prefix`), so the audience
 * the New form proposes for an app (R15).
 */
export const DEFAULT_SSO_AUDIENCE_PREFIX = "devresponse-app";

/**
 * R15: true when `audience` is one the satellite of app `appId` can consume:
 * `<prefix>:<appId>`, where the prefix is non-empty and holds no `:` and no
 * whitespace.
 *
 * A satellite's consume route accepts only a token whose `aud` is
 * `${SSO_HANDOFF_AUDIENCE_PREFIX}:${SSO_HANDOFF_APPLICATION_ID}` and whose
 * `targetApplicationId`, the app's catalog id, is that same application id
 * (src/app/api/sso/consume/route.ts). So an app registered under any other
 * audience (`acme.crm`, or `x:acme.other` for app `acme.crm`) looks healthy in
 * the console and every launch of it fails at the satellite. Because the last
 * segment is the app's own id, an org admin's app id under its slug (I-01)
 * also keeps its audience out of every other name.
 */
export function isConsumableAudienceFor(audience: string, appId: string): boolean {
  const suffix = `:${appId}`;
  if (appId.length === 0 || !audience.endsWith(suffix)) return false;
  const prefix = audience.slice(0, -suffix.length);
  return prefix.length > 0 && !/[:\s]/.test(prefix);
}

/**
 * Returns true when `value` is a syntactically valid HTTPS origin per
 * §8.7. We require the URL to parse, the protocol to be `https:`,
 * and the value to NOT carry a path/search/hash component — origins
 * by definition are scheme + authority only.
 */
export function isHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Reject anything beyond the authority component.
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  // `URL.origin` strips trailing slashes — compare the canonical form
  // to ensure the caller passed an origin (no trailing slash drift).
  return url.origin === value || url.origin + "/" === value;
}

/**
 * Allowed enterprise-application status values. Kept narrow to avoid
 * UI/API drift; expand here when product needs additional states.
 */
export const APP_STATUS_VALUES = ["available", "disabled"] as const;
export type AppStatus = (typeof APP_STATUS_VALUES)[number];
