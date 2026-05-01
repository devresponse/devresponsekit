import { getTranslations } from "next-intl/server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { ShellContainer } from "@/components/app-shell/shell-container";
import { ShellSkipLinks } from "@/components/app-shell/shell-skip-links";
import { TopShellBar } from "@/components/app-shell/top-shell-bar";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import type { ReactNode } from "react";

/**
 * PublicLayout
 *
 * Default app-shell wrapper for the unsecure `(public)` route group
 * (`/[locale]`, `/[locale]/about`, `/[locale]/docs`, `/[locale]/logged-out`).
 *
 * Per spec §28.2:
 *   - Lightweight public shell only (brand bar + main).
 *   - No secure menu API calls and no secure shell hydration.
 *   - Comfortable density (no `CompactDensityWrapper`).
 *   - Normal document scrolling — the shell is `min-h-screen` rather
 *     than viewport-bounded so long marketing content scrolls naturally.
 *
 * Authentication is not required to render any descendant; the proxy
 * (`src/proxy.ts`) leaves public paths untouched and only the secure
 * group enforces a session.
 */
export default async function PublicLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const safeLocale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const tCommon = await getTranslations({ locale: safeLocale, namespace: "common" });

  return (
    <div className="min-h-screen">
      <ShellSkipLinks />
      <ShellContainer
        ariaLabel="DevResponse public site"
        leftVisible={false}
        rightVisible={false}
        footerVisible={false}
        branding={
          <TopShellBar>
            <LocaleLink
              href="/"
              locale={safeLocale}
              className="text-sm font-semibold"
            >
              {tCommon("appName")}
            </LocaleLink>
            <div className="ml-auto flex items-center gap-2">
              <LocaleSwitcher current={safeLocale} />
              <LocaleLink
                href="/sign-in"
                locale={safeLocale}
                className="border-shell-border hover:bg-shell-muted rounded-md border px-3 py-1.5 text-sm"
              >
                {tCommon("signIn")}
              </LocaleLink>
              <LocaleLink
                href="/sign-up"
                locale={safeLocale}
                className="bg-shell-fg text-shell-bg hover:opacity-90 rounded-md px-3 py-1.5 text-sm"
              >
                {tCommon("signUp")}
              </LocaleLink>
            </div>
          </TopShellBar>
        }
      >
        {children}
      </ShellContainer>
    </div>
  );
}
