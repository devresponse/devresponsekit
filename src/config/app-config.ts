/**
 * Application-wide configuration constants.
 *
 * Values here are either compile-time constants or are read from
 * `NEXT_PUBLIC_*` environment variables that Next.js inlines at build time.
 * Do NOT import server-side secrets here — use `getServerEnv()` from
 * `@/lib/env` for those.
 */

/** Public-facing application name shown in the browser title bar and headings. */
export const APP_NAME =
  process.env.NEXT_PUBLIC_APP_NAME ?? "DevResponse Enterprise Platform";

/** Base URL of the application. Used for absolute link generation and OAuth redirects. */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/** Primary host for the production deployment (used for subdomain SSO checks). */
export const PRIMARY_HOST =
  process.env.NEXT_PUBLIC_PRIMARY_HOST ?? "localhost";

/** Production hostname for the main enterprise app. */
export const PRODUCTION_HOST =
  process.env.NEXT_PUBLIC_PRODUCTION_HOST ?? "app.devresponse.com";

/** Rolling session duration in seconds (8 hours). */
export const SESSION_DURATION_SECONDS = 8 * 60 * 60;

/** Session rolling update interval in seconds (15 minutes). */
export const SESSION_UPDATE_INTERVAL_SECONDS = 15 * 60;
