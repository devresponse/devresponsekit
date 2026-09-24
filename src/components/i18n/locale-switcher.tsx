"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { locales, LOCALE_LABELS, type SupportedLocale } from "@/config/i18n-config";
import { useTranslations } from "next-intl";
import { useSwitchLocale } from "./use-switch-locale";

export interface LocaleSwitcherProps {
  current: SupportedLocale;
  /** When true, persists the choice via /api/preferences/locale. */
  persistAuthenticated?: boolean;
}

/**
 * LocaleSwitcher
 *
 * Switches only the locale segment of the current URL while preserving
 * the path, the query string and the fragment byte-for-byte, so an invite
 * token, an invited sign-up, a `returnTo` continuation or a grid's filters
 * survive a language change (F-35; the logic lives in `useSwitchLocale`,
 * shared with `LanguageMenu`). Never switches API routes — `next-intl`
 * navigation helpers refuse to rewrite paths outside the localized tree.
 *
 * For authenticated users, the selection is persisted via the locale
 * preference API which audit-logs `i18n.locale.changed`.
 */
export function LocaleSwitcher({ current, persistAuthenticated = false }: LocaleSwitcherProps) {
  const t = useTranslations("common");
  const { switchLocale, isPending } = useSwitchLocale({ persistAuthenticated });

  return (
    <Select value={current} onValueChange={switchLocale} disabled={isPending}>
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
