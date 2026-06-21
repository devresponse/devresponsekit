"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { locales, type SupportedLocale } from "@/config/i18n-config";
import { useTranslations } from "next-intl";

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  uk: "Українська",
  pt: "Português",
  zh: "简体中文",
};

export interface LocaleSwitcherProps {
  current: SupportedLocale;
  /** When true, persists the choice via /api/preferences/locale. */
  persistAuthenticated?: boolean;
}

/**
 * LocaleSwitcher
 *
 * Switches only the locale segment of the current URL while preserving
 * the path and query parameters. Never switches API routes — `next-intl`
 * navigation helpers refuse to rewrite paths outside the localized tree.
 *
 * For authenticated users, the selection is persisted via the locale
 * preference API which audit-logs `i18n.locale.changed`.
 */
export function LocaleSwitcher({ current, persistAuthenticated = false }: LocaleSwitcherProps) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const handleChange = (next: string) => {
    if (!locales.includes(next as SupportedLocale)) return;
    startTransition(() => {
      router.replace(pathname, { locale: next as SupportedLocale });
      if (persistAuthenticated) {
        // Fire-and-forget: server validates and audits.
        void fetch("/api/preferences/locale", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locale: next }),
        });
      }
    });
  };

  return (
    <Select value={current} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger aria-label={t("language")} className="h-8 w-[10rem] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {locales.map((locale) => (
          <SelectItem key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
