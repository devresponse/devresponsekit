"use client";

import { useTranslations } from "next-intl";
import { locales, type SupportedLocale } from "@/config/i18n-config";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useTransition } from "react";

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  uk: "Українська",
};

/**
 * LanguageMenu
 *
 * Client Component that renders locale options as a plain list of buttons,
 * suitable for embedding in a dropdown menu or footer. Unlike `LocaleSwitcher`,
 * it does not use the `<Select>` primitive — callers control the container.
 *
 * i18n: the current locale is highlighted so users can identify the active
 * selection without additional context.
 *
 * Accessibility: each button has an accessible name derived from the full
 * language name, not just the ISO code.
 */
export function LanguageMenu({
  current,
  persistAuthenticated = false,
}: {
  current: SupportedLocale;
  persistAuthenticated?: boolean;
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const handleSelect = (locale: SupportedLocale) => {
    if (locale === current) return;
    startTransition(() => {
      router.replace(pathname, { locale });
      if (persistAuthenticated) {
        void fetch("/api/preferences/locale", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locale }),
        });
      }
    });
  };

  return (
    <nav aria-label={t("language")}>
      <ul className="flex flex-col gap-1">
        {locales.map((locale) => (
          <li key={locale}>
            <button
              type="button"
              disabled={isPending}
              aria-current={locale === current ? "true" : undefined}
              onClick={() => handleSelect(locale)}
              className="w-full rounded px-3 py-1.5 text-left text-sm hover:bg-neutral-100 aria-[current=true]:font-semibold"
            >
              {LOCALE_LABELS[locale]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
