/**
 * Single source of truth for the origins trusted by BOTH security
 * layers:
 *
 *   1. Better Auth's `trustedOrigins` option (cookie / CSRF checks).
 *   2. The administrator mutation origin guard
 *      (`src/lib/admin/origin-guard.server.ts`).
 *
 * The list is the union of:
 *   - `NEXT_PUBLIC_APP_URL` (the deployed app's own origin),
 *   - `BETTER_AUTH_URL` (usually the same origin),
 *   - `ADMIN_TRUSTED_ORIGINS` (comma-separated extras, e.g. the
 *     production host when running behind a preview URL).
 *
 * No origin is hard-coded here: deployments declare their own origins
 * via environment so the two layers can never drift apart.
 *
 * Reads `process.env` directly (not the cached `getServerEnv()`) so the
 * per-request origin guard stays overridable in tests and scripts.
 */

/** Normalizes a URL-ish string to `protocol//host`, or null when invalid. */
export function parseOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** Returns the deduplicated, normalized trusted-origin allow-list. */
export function getTrustedOrigins(): string[] {
  const fromEnv = (process.env.ADMIN_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = [process.env.NEXT_PUBLIC_APP_URL, process.env.BETTER_AUTH_URL, ...fromEnv];
  return [...new Set(candidates.map((v) => parseOrigin(v)).filter((v): v is string => v !== null))];
}
