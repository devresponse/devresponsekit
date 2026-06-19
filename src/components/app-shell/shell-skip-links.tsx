import { useTranslations } from "next-intl";

/**
 * ShellSkipLinks
 *
 * Visually hidden until focused. Provides keyboard users a fast path to
 * the main content and primary navigation regions of the shell.
 *
 * Targets `#main` and `#navigation`, which are the IDs assigned by
 * `ShellGridContainer` to the main and left aside elements.
 */
export function ShellSkipLinks() {
  const t = useTranslations("shell");
  return (
    <nav aria-label={t("regions.skipLinks")}>
      <a href="#main" className="sh-skip-link">
        {t("skipToMain")}
      </a>
      <a href="#navigation" className="sh-skip-link">
        {t("skipToNavigation")}
      </a>
    </nav>
  );
}
