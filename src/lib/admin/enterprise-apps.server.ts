import "server-only";

/**
 * Server-only re-export shim for the enterprise-apps validators
 * (docs/admin-manager.md §8.10, Phase 6).
 *
 * The actual rules live in `./enterprise-apps` so the client form
 * bundles can consume them. Server modules import from here so the
 * `server-only` guard still applies to anything that pulls in this
 * file from a server context.
 */
export {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
  isHttpsOrigin,
  type AppStatus,
} from "./enterprise-apps";
