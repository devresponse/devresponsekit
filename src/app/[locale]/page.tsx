import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";

/**
 * Localized landing page.
 *
 * Lightweight public page; intentionally does not call any secure menu
 * APIs nor hydrate the secure shell store. Comfortable density per §28.2.
 */
export default async function LocaleHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en";
  return <Body locale={safeLocale} />;
}

function Body({ locale }: { locale: SupportedLocale }) {
  const t = useTranslations("common");
  const tAuth = useTranslations("auth");
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("appName")}</h1>
        <LocaleSwitcher current={locale} />
      </header>
      <Card>
        <CardHeader>
          <CardTitle>{tAuth("signInTitle")}</CardTitle>
          <CardDescription>{tAuth("haveAccount")}</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-3">
          <LocaleLink
            href="/sign-in"
            locale={locale}
            className="border-shell-border hover:bg-shell-muted rounded-md border px-3 py-1.5 text-sm"
          >
            {t("signIn")}
          </LocaleLink>
          <LocaleLink
            href="/sign-up"
            locale={locale}
            className="border-shell-border hover:bg-shell-muted rounded-md border px-3 py-1.5 text-sm"
          >
            {t("signUp")}
          </LocaleLink>
        </CardContent>
      </Card>
    </main>
  );
}
