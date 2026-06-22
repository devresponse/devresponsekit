/**
 * Brand — the single source of truth for white-label identity (white-label Phase 0).
 *
 * Consolidates the brand name, logo, and favicon that were previously scattered
 * across hardcoded `"DevResponse"` literals, the `common.appName` i18n key, and
 * `NEXT_PUBLIC_APP_NAME`. Everything brandable now resolves through
 * {@link getBrand} (text) or the `BrandLogo` component (the brand mark).
 *
 * Phase 0 ships a single `default` brand that reproduces today's look exactly:
 * the name comes from `NEXT_PUBLIC_APP_NAME` (default "DevResponse Enterprise"),
 * there is no image logo (the brand renders as its wordmark — see `BrandLogo`),
 * and the favicon is the existing `/favicon.png`.
 *
 * Later phases make `getBrand()` request-scoped (resolved by host/organization)
 * and DB-backed; call sites do not change shape — only the resolver behind them.
 * This module is intentionally free of `server-only` and Node APIs so it is
 * importable from both Server and Client Components (`NEXT_PUBLIC_APP_NAME` is
 * inlined into client bundles, so the resolved name matches on both sides).
 */

/** Full display name, e.g. "DevResponse Enterprise". */
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "DevResponse Enterprise";

export interface Brand {
  /** Stable identifier; `"default"` is the built-in fallback brand. */
  id: string;
  /** Full display name — page titles, headings, prose. */
  name: string;
  /** Compact name for tight chrome — the shell header and the `%s · …` title template. */
  shortName: string;
  /**
   * Logo image URLs per color scheme. `null` means "no image" — the brand
   * renders as its {@link name}/{@link shortName} wordmark (today's default).
   * Phase 1 populates these for image logos; `BrandLogo` is where they render.
   */
  logo: { light: string | null; dark: string | null };
  /** Favicon URL (served from `/public` today; a CDN URL in later phases). */
  favicon: string;
}

/**
 * The built-in fallback brand. Reproduces the pre-white-label look exactly:
 * name/shortName derived from `NEXT_PUBLIC_APP_NAME`, no image logo, and the
 * existing favicon.
 */
export const DEFAULT_BRAND: Brand = {
  id: "default",
  name: APP_NAME,
  // First token of the full name ("DevResponse Enterprise" → "DevResponse").
  shortName: APP_NAME.split(/\s+/)[0] || APP_NAME,
  logo: { light: null, dark: null },
  favicon: "/favicon.png",
};

/**
 * Resolves the active brand. Phase 0: always {@link DEFAULT_BRAND}. The
 * signature is deliberately synchronous and argument-free so it works in any
 * component; the request-scoped resolver in later phases keeps this contract
 * (falling back to the default brand for unknown hosts).
 */
export function getBrand(): Brand {
  return DEFAULT_BRAND;
}
