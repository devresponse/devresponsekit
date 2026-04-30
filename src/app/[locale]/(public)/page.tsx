import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";

/**
 * LocaleHome — default public landing page.
 *
 * Server Component. Rendered at `/[locale]` inside the (public) group layout
 * so it always uses comfortable density. No secure menu APIs are called;
 * no session cookie is required.
 *
 * Security: this page is intentionally public and must never trigger an
 * authentication redirect. `proxy.ts` only guards `/[locale]/app/*` paths.
 *
 * i18n: all visible strings come from the `common` and `auth` message
 * namespaces so they are translatable across the four supported locales.
 *
 * Layout: normal document scroll; no viewport-bounded shell.
 */
export default async function LocaleHome({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Validate the locale so the downstream `useTranslations` call is safe.
  const safeLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en";
  return <Body locale={safeLocale} />;
}

/**
 * Body
 *
 * Client-compatible inner component that reads i18n messages. Kept separate
 * from the async page so it can be tested in isolation with `renderWithIntl`.
 */
function Body({ locale }: { locale: SupportedLocale }) {
  const t = useTranslations("common");
  const tAuth = useTranslations("auth");

  return (
    <div className="flex min-h-screen flex-col">
      {/* Public navigation bar — shows locale switcher and sign-in link */}
      <header className="border-b px-6 py-3">
        <nav
          className="mx-auto flex max-w-5xl items-center justify-between"
          aria-label="Public navigation"
        >
          <LocaleLink href="/" locale={locale} className="text-lg font-semibold">
            {t("appName")}
          </LocaleLink>
          <div className="flex items-center gap-3">
            <LocaleSwitcher current={locale} />
            {/* Sign-in CTA in the nav for quick access by returning visitors */}
            <Button asChild variant="outline" size="sm">
              <LocaleLink href="/sign-in" locale={locale}>
                {t("signIn")}
              </LocaleLink>
            </Button>
          </div>
        </nav>
      </header>

      {/* Hero section */}
      <main id="main" className="flex-1">
        <section className="mx-auto max-w-5xl px-6 py-20 text-center">
          <h1 className="mb-4 text-4xl font-bold tracking-tight">
            {t("appName")}
          </h1>
          <p className="mx-auto mb-8 max-w-xl text-lg text-neutral-600">
            Enterprise-grade application shell with secure multi-tenant access,
            locale-aware routing, and SSO application switching.
          </p>
          {/* Primary CTAs for unauthenticated visitors */}
          <div className="flex justify-center gap-4">
            <Button asChild size="lg">
              <LocaleLink href="/sign-up" locale={locale}>
                {tAuth("createAccount")}
              </LocaleLink>
            </Button>
            <Button asChild variant="outline" size="lg">
              <LocaleLink href="/sign-in" locale={locale}>
                {t("signIn")}
              </LocaleLink>
            </Button>
          </div>
        </section>

        {/* Quick-link cards for major public destinations */}
        <section className="mx-auto max-w-5xl px-6 pb-20">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>About</CardTitle>
                <CardDescription>Learn about the DevResponse platform.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <LocaleLink href="/about" locale={locale}>
                    Learn more
                  </LocaleLink>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Documentation</CardTitle>
                <CardDescription>Browse the developer documentation.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <LocaleLink href="/docs" locale={locale}>
                    Read docs
                  </LocaleLink>
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    </div>
  );
}
