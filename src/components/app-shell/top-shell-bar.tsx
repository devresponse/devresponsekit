import { cn } from "@/lib/utils";

/**
 * TopShellBar
 *
 * Sticky brand bar at the top of the root shell. Content-agnostic
 * `children` slot whose contents are supplied by the calling layout — the
 * secure layout renders the sidebar trigger, brand, application/organization
 * switchers, theme + locale toggles and sign-out; the public layout renders
 * the brand, locale switcher and sign-in/sign-up links (review #179).
 * Server-compatible by default; interactive children opt-in to "use client".
 *
 * Theme: the bar is PERMANENTLY DARK. The `dark` class scopes the app's
 * dark palette (globals.css `.dark { --… }`) onto the header subtree, so
 * its background, text, and border — and every semantic-token child
 * control inside it — resolve to the dark palette in BOTH page themes.
 * CSS custom properties are set on the element itself, so this subtree
 * override always wins over the document-level theme: the bar gives
 * contrast against the light body, and does NOT flip when the user
 * switches the page to dark. (The bar's own `color` comes from
 * `.sh-top-bar` so bare-inheriting children read light, not the document
 * foreground.)
 *
 * Accessibility: rendered as a `header` landmark distinct from the
 * inner page header so screen readers can navigate to brand controls
 * separately from page-level controls.
 */
export function TopShellBar({
  children,
  className,
  ariaLabel = "Application brand bar",
}: {
  children?: React.ReactNode;
  className?: string;
  /**
   * Landmark label for the banner. Server Component, so it cannot call
   * useTranslations — the parent layout passes the localized string (P2-15).
   * Defaults to English for any caller that has not been localized yet.
   */
  ariaLabel?: string;
}) {
  return (
    <header
      className={cn("sh-top-bar dark gap-3 px-4", className)}
      role="banner"
      aria-label={ariaLabel}
    >
      {children}
    </header>
  );
}
