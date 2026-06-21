"use client";

import { useTransition } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { usePathname, useRouter } from "@/i18n/navigation";
import { locales, type SupportedLocale } from "@/config/i18n-config";

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  uk: "Українська",
  pt: "Português",
  zh: "简体中文",
};

export interface LanguageMenuProps {
  current: SupportedLocale;
  /** When true, persists the choice via /api/preferences/locale. */
  persistAuthenticated?: boolean;
  className?: string;
}

/**
 * LanguageMenu
 *
 * Client Component. Menu-style sibling of `LocaleSwitcher` for toolbars
 * and footers where a dropdown menu reads better than a select. Like
 * `LocaleSwitcher`, it only swaps the locale segment of the current URL
 * via `next-intl`'s `useRouter().replace`, preserving the path and query
 * — never accidentally rewriting an `/api/*` route.
 *
 * For authenticated users, the chosen locale is persisted via
 * `/api/preferences/locale` (fire-and-forget; the server validates the
 * input and audit-logs `i18n.locale.changed`).
 *
 * Accessibility: built on Radix DropdownMenu so the trigger announces as
 * a menu button and items are keyboard-navigable. The trigger label
 * combines the localized "Language" word with the current locale's
 * native name so screen readers announce the active value.
 */
export function LanguageMenu({
  current,
  persistAuthenticated = false,
  className,
}: LanguageMenuProps) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const select = (next: SupportedLocale) => {
    if (next === current) return;
    startTransition(() => {
      router.replace(pathname, { locale: next });
      if (persistAuthenticated) {
        void fetch("/api/preferences/locale", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locale: next }),
        });
      }
    });
  };

  const triggerLabel = `${t("language")}: ${LOCALE_LABELS[current]}`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={triggerLabel}
          disabled={isPending}
          className={className}
        >
          <Globe className="mr-2 h-4 w-4" aria-hidden="true" />
          {LOCALE_LABELS[current]}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="border-border bg-card z-50 min-w-[10rem] rounded-md border p-1 text-sm shadow-md"
        >
          <DropdownMenu.RadioGroup
            value={current}
            onValueChange={(value) => select(value as SupportedLocale)}
          >
            {locales.map((locale) => (
              <DropdownMenu.RadioItem
                key={locale}
                value={locale}
                className="hover:bg-muted focus:bg-muted cursor-pointer rounded px-2 py-1.5 outline-none data-[state=checked]:font-semibold"
              >
                {LOCALE_LABELS[locale]}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
