import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";

/**
 * Sanitizes a `returnTo` value before redirecting after sign-in.
 *
 * Threat model:
 *   - Open redirect via absolute URLs (`https://evil.com`).
 *   - Open redirect via protocol-relative URLs (`//evil.com`).
 *   - Backslash smuggling (`/\\evil.com`) which some browsers normalize.
 *   - Returning to API or auth/status pages, which would create loops or
 *     leak unintended privileges.
 *
 * Only same-origin localized browser paths are allowed.
 */
export function getSafeReturnTo(
  value: string | null | undefined,
  locale: string = defaultLocale,
): string {
  const safeLocale = isSupportedLocale(locale) ? locale : defaultLocale;
  const fallback = `/${safeLocale}/app/dashboard`;

  if (!value) return fallback;
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  if (value.includes("\\")) return fallback;
  if (value.startsWith("/api/")) return fallback;

  // First two path segments are `["", locale, segment]` because of the
  // leading slash. Validate the locale segment and reject auth/status pages.
  const parts = value.split("/");
  const maybeLocale = parts[1] ?? "";
  const segment = parts[2] ?? "";

  if (!isSupportedLocale(maybeLocale)) return fallback;
  if (
    ["sign-in", "sign-up", "forgot-password", "blocked", "pending-approval", "logged-out"].includes(
      segment,
    )
  ) {
    return fallback;
  }

  return value;
}
