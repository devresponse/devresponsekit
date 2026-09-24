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

/**
 * The `returnTo` for an auth page rendered in `locale`: {@link getSafeReturnTo},
 * then its locale segment re-pointed at `locale`. The sign-in, scoped sign-in
 * and sign-up pages call this instead of the bare sanitizer.
 *
 * F-35: the language switcher keeps the query string byte-for-byte, so after a
 * switch `/fr/sign-in?returnTo=%2Fen%2Fapp%2Fdashboard` still names the page in
 * the locale it was minted with. Every producer of that URL (the proxy's
 * signed-out redirect, `requireSecureSession`, the signed-out SSO launch, the
 * invite panel) mints it in the sign-in page's own locale, so the two differ
 * only after the user picked another language (or edited the URL by hand).
 * Honouring the minted `/en`
 * would undo that choice after sign-in, and the sign-in switcher persists
 * nothing, so the choice would be lost. Only the locale segment changes. The
 * path, query and fragment are kept byte-for-byte, and nothing is decoded or
 * re-encoded: `searchParams` has already decoded the value once.
 *
 * Re-pointing cannot change the sanitizer's verdict. The input is either the
 * fallback, already in `locale`, or a value whose second segment is a
 * supported locale. Swapping one supported locale for another keeps the leading
 * `/` and adds no `//`, `\` or `/api/` (no locale is `api`). It also leaves the
 * page segment that the auth/status rule reads untouched, so
 * `getSafeReturnTo(result, locale) === result` for every input (pinned by a
 * property test). A `returnTo` to the SSO launch trampoline is re-pointed too;
 * that page renders nothing and forwards the `locale=` of its own query, so
 * the handoff still goes out in the locale the satellite asked for.
 */
export function getSafeReturnToInLocale(
  value: string | null | undefined,
  locale: string = defaultLocale,
): string {
  const safeLocale = isSupportedLocale(locale) ? locale : defaultLocale;
  const parts = getSafeReturnTo(value, safeLocale).split("/");
  parts[1] = safeLocale;
  return parts.join("/");
}
