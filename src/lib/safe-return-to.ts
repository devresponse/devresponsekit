import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";

/** A `.` or `..` path segment, literal or percent-encoded, in any case. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Better Auth's `CONTROL_CHARACTER_PATTERN` (C0, DEL and C1). Built from an
 * escaped string so the source holds no literal control byte and needs no
 * `no-control-regex` suppression.
 */
const CONTROL_CHARACTER = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");

/** A percent-encoded `/` or `\`, which Better Auth refuses in a relative path. */
const ENCODED_PATH_SEPARATOR = /%2f|%5c/i;

/**
 * I-17: whether the browser would navigate to a different path than the one
 * {@link getSafeReturnTo} inspects, or Better Auth would refuse the value.
 * The checks read the string as written, but a browser parses it as a URL
 * first, and the URL parser:
 *   - strips a trailing space or C0 control and deletes every tab, LF and CR,
 *     so `/en/sign-in `, `/en/sign-in\u0000` and `/en/sign\t-in` all land on
 *     `/en/sign-in`;
 *   - drops `.` segments and resolves `..` against the one before it, so
 *     `/en/../api/x` is `/api/x` and `/en/./sign-in` is `/en/sign-in`;
 *   - reads `%2e` as a dot while doing so (`/en/%2e%2e/api/x`).
 * Each of them let a value the checks accepted land on an `/api/` route or an
 * auth page that they refuse. An accepted value also becomes the sign-in
 * form's `callbackURL`, and Better Auth's `isSafeRelativeURL` refuses any
 * control character (DEL and C1 included) and an encoded `/` or `\` in the
 * path: that would fail the sign-in with a 403 instead of landing on the
 * fallback, so those are refused here too.
 *
 * Such a value is rejected outright rather than canonicalized: the sanitizer
 * keeps returning what the caller sent, byte-for-byte, which
 * `getSafeReturnToInLocale` relies on, and no path the app itself mints
 * contains one. Dot segments and encoded separators are looked for in the
 * path only: the parser resolves none in the query or the fragment.
 */
function resolvesElsewhere(value: string, path: string): boolean {
  if (CONTROL_CHARACTER.test(value) || value.endsWith(" ")) return true;
  if (ENCODED_PATH_SEPARATOR.test(path)) return true;
  return path.split("/").some((segment) => DOT_SEGMENT.test(segment));
}

/**
 * Sanitizes a `returnTo` value before redirecting after sign-in.
 *
 * Threat model:
 *   - Open redirect via absolute URLs (`https://evil.com`).
 *   - Open redirect via protocol-relative URLs (`//evil.com`).
 *   - Backslash smuggling (`/\\evil.com`) which some browsers normalize.
 *   - Returning to API or auth/status pages, which would create loops or
 *     leak unintended privileges.
 *   - Dot segments (`/en/../api/…`, `/en/%2e%2e/api/…`, `/en/./sign-in`),
 *     control characters and a trailing space, which the browser resolves or
 *     deletes before it navigates, so the checks below would judge the wrong
 *     path (I-17).
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
  // The query and the fragment choose nothing the browser routes on:
  // `/en/sign-in?x` and `/en/sign-in#x` are the sign-in page (I-17).
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (resolvesElsewhere(value, path)) return fallback;

  // `["", locale, segment]` because of the leading slash. The locale must be a
  // whole segment of the value as written, so no query or fragment follows it
  // directly and re-pointing it (`getSafeReturnToInLocale`) leaves both
  // untouched; the auth/status rule reads the page segment of the path.
  const maybeLocale = value.split("/")[1] ?? "";
  const segment = path.split("/")[2] ?? "";

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
