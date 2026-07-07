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
