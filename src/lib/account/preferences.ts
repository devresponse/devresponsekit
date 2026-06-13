/**
 * Account preferences — shared, pure validation helpers.
 *
 * Free of `server-only` and runtime imports so the client form, the API
 * route's Zod schema, and unit tests all consume the SAME allowed-value
 * definitions (they cannot drift). Mirrors the pattern used by
 * `src/lib/admin/permissions.ts`.
 */

/**
 * Display formats for dates. Stored as the key string in
 * `app_user_locale_preferences.date_format`; the empty option ("system")
 * persists as NULL (follow the active locale's default).
 */
export const DATE_FORMAT_OPTIONS = ["system", "iso8601", "us", "eu", "long"] as const;
export type DateFormatOption = (typeof DATE_FORMAT_OPTIONS)[number];

export function isDateFormatOption(value: unknown): value is DateFormatOption {
  return typeof value === "string" && (DATE_FORMAT_OPTIONS as readonly string[]).includes(value);
}

/**
 * Validates an IANA time-zone name without a hardcoded list: a value is
 * valid iff the runtime's Intl engine accepts it. `"system"` (follow the
 * browser/server default) is represented as an empty selection → NULL.
 */
export function isValidTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    // Throws RangeError for an unknown time zone.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes a "system"/empty sentinel to NULL for storage; otherwise
 * returns the trimmed value. Callers validate the non-null case
 * separately (time zone via {@link isValidTimeZone}, date format via
 * {@link isDateFormatOption}, number-format locale via the supported
 * locale guard).
 */
export function normalizeOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "system") return null;
  return trimmed;
}
