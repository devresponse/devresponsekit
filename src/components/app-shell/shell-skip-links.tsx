import { useTranslations } from "next-intl";

/**
 * ShellSkipLinks
 *
 * Visually hidden until focused. Provides keyboard users a fast path to
 * the main content and primary navigation regions of the shell.
 *
 * Targets `#main` and `#navigation`, which are the IDs assigned by
 * `ShellGridContainer` to the ROOT shell's main and left aside elements
 * (a nested shell gets depth-suffixed ids — review #105).
 *
 * `hasNavigation` gates the second link (review #104). The public shell
 * renders with `leftVisible={false}`, so `#navigation` never mounts there
 * and the link was a dead anchor that moved focus nowhere — worse than no
 * skip link, because a keyboard user has to tab past it to reach the page.
 */
export function ShellSkipLinks({ hasNavigation = true }: { hasNavigation?: boolean }) {
  const t = useTranslations("shell");
  return (
    <nav aria-label={t("regions.skipLinks")}>
      <a href="#main" className="sh-skip-link">
        {t("skipToMain")}
      </a>
      {hasNavigation ? (
        <a href="#navigation" className="sh-skip-link">
          {t("skipToNavigation")}
        </a>
      ) : null}
    </nav>
  );
}
