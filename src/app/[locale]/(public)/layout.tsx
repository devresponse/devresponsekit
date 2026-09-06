import { getTranslations } from "next-intl/server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { ShellContainer } from "@/components/app-shell/shell-container";
import { ShellSkipLinks } from "@/components/app-shell/shell-skip-links";
import { TopShellBar } from "@/components/app-shell/top-shell-bar";
import { BrandLogo } from "@/components/brand/brand-logo";
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
 *
 * Landmarks (review #104): `ShellContainer` renders the ONE `<main>` of
 * the document, so every `(public)` page root is a plain element — a page
 * that opened with its own `<main>` produced nested main landmarks.
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
  // Localized landmark labels (review #106) — the shell components are
  // Server Components and cannot call `useTranslations` themselves.
  const tRegions = await getTranslations({ locale: safeLocale, namespace: "shell.regions" });

  return (
    <div className="min-h-screen">
      {/* The public shell has no left region, so `#navigation` never mounts
          and the skip link would be dead (review #104). */}
      <ShellSkipLinks hasNavigation={false} />
      <ShellContainer
        ariaLabel={tRegions("publicSite")}
        leftVisible={false}
        rightVisible={false}
        footerVisible={false}
        branding={
          <TopShellBar ariaLabel={tRegions("banner")}>
            <LocaleLink href="/" locale={safeLocale} className="text-sm font-semibold">
              <BrandLogo />
            </LocaleLink>
            <div className="ml-auto flex items-center gap-2">
              <LocaleSwitcher current={safeLocale} />
              <LocaleLink
                href="/sign-in"
                locale={safeLocale}
                className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
              >
                {tCommon("signIn")}
              </LocaleLink>
              <LocaleLink
                href="/sign-up"
                locale={safeLocale}
                className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm hover:opacity-90"
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
