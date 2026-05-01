import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";

/**
 * Localized landing page (default home).
 *
 * Lives in the `(public)` route group so the default home route
 * `/[locale]` is unambiguously an unsecure page per spec §28.2:
 * lightweight public shell, comfortable density, no secure menu API
 * calls, and no secure shell hydration. Authentication is reachable
 * only through explicit, locale-safe `LocaleLink`s to `/sign-in` and
 * `/sign-up` — visitors can browse the public section without signing in.
 *
 * The brand bar (locale switcher + sign-in / sign-up) is provided by
 * `(public)/layout.tsx`; this page renders the hero section only.
 */
export default async function LocaleHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en";
  return <Hero locale={safeLocale} />;
}

function Hero({ locale }: { locale: SupportedLocale }) {
  const t = useTranslations("public");
  const tCommon = useTranslations("common");
  return (
    <section
      aria-labelledby="hero-heading"
      className="mx-auto flex max-w-4xl flex-col items-start gap-6 px-6 py-16 sm:py-24"
    >
      <p className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
        {t("heroEyebrow")}
      </p>
      <h1
        id="hero-heading"
        className="text-4xl leading-tight font-semibold tracking-tight sm:text-5xl"
      >
        {t("heroTitle")}
      </h1>
      <p className="max-w-2xl text-lg text-neutral-600">{t("heroSubtitle")}</p>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <LocaleLink
          href="/sign-up"
          locale={locale}
          className="bg-shell-fg text-shell-bg rounded-md px-4 py-2 text-sm font-medium hover:opacity-90"
        >
          {t("heroPrimaryCta")}
        </LocaleLink>
        <LocaleLink
          href="/about"
          locale={locale}
          className="border-shell-border hover:bg-shell-muted rounded-md border px-4 py-2 text-sm font-medium"
        >
          {t("heroSecondaryCta")}
        </LocaleLink>
        <LocaleLink
          href="/sign-in"
          locale={locale}
          className="hover:bg-shell-muted rounded-md px-4 py-2 text-sm font-medium"
        >
          {tCommon("signIn")}
        </LocaleLink>
      </div>
    </section>
  );
}
