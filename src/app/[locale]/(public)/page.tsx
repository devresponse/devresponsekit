import Image from "next/image";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  BookOpen,
  Check,
  KeyRound,
  Languages,
  LayoutDashboard,
  Lock,
  Mail,
  Network,
  ShieldCheck,
} from "lucide-react";
import { GithubIcon } from "@/components/icons/github-icon";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";

/**
 * Localized landing page (default home, `/[locale]`).
 *
 * Lives in the `(public)` route group so the default home route is
 * unambiguously an unsecure page (spec §28.2): lightweight public shell,
 * comfortable density, no secure menu API calls, no secure hydration.
 *
 * The page is a showcase for DevResponseKit itself — its copy is drawn
 * from `docs/product-overview.md` and every string is localized via
 * the `public` message namespace, so the whole page respects the active
 * locale. The brand bar (locale switcher + sign-in / sign-up) comes from
 * `(public)/layout.tsx`; this file renders the marketing sections.
 *
 * Translations carry no interactivity, so this stays a server component;
 * the only client surface is plain links. The primary call to action
 * points at the public GitHub repository — the kit is free and open
 * source.
 */
const GITHUB_URL = "https://github.com/devresponse/devresponsekit";

/**
 * Locales that ship a localized hero screenshot (`/public/front1-<locale>.avif`,
 * a 1200px-wide AVIF of the product in that language). A locale without its own
 * capture falls back to English so the hero never 404s.
 */
const HERO_SCREENSHOT_LOCALES = new Set<SupportedLocale>([
  "en",
  "fr",
  "es",
  "uk",
  "pt",
  "zh",
  "hi",
  "ja",
]);

/** Per-feature icons, zipped with the localized feature list by index. */
const FEATURE_ICONS = [
  LayoutDashboard,
  ShieldCheck,
  KeyRound,
  Network,
  Mail,
  Languages,
  BookOpen,
  Lock,
] as const;

interface TitledItem {
  title: string;
  description: string;
}
interface Stat {
  value: string;
  label: string;
}

export default async function LocaleHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en";
  return <Landing locale={safeLocale} />;
}

function Landing({ locale }: { locale: SupportedLocale }) {
  const t = useTranslations("public");
  const stats = t.raw("stats.items") as Stat[];
  const features = t.raw("features.items") as TitledItem[];
  const whyItems = t.raw("why.items") as TitledItem[];
  const stack = t.raw("stack.items") as string[];

  // Locale-aware hero screenshot: the product shown in the active language.
  const heroLocale = HERO_SCREENSHOT_LOCALES.has(locale) ? locale : "en";
  const heroScreenshot = `/front1-${heroLocale}.avif`;

  return (
    <main className="flex flex-col">
      {/* ---------------------------------------------------------------- Hero */}
      <section
        aria-labelledby="hero-heading"
        className="border-border relative overflow-hidden border-b"
      >
        <div
          aria-hidden
          className="from-muted/60 to-background pointer-events-none absolute inset-0 bg-gradient-to-b"
        />
        <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-20 text-center sm:py-28">
          <span className="border-border bg-background/70 text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
            <span className="bg-primary h-1.5 w-1.5 rounded-full" aria-hidden />
            {t("hero.eyebrow")}
          </span>
          <h1
            id="hero-heading"
            className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
          >
            {t("hero.title")}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-lg text-pretty">
            {t("hero.subtitle")}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Button asChild size="lg">
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                <GithubIcon className="h-4 w-4" />
                {t("hero.primaryCta")}
              </a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <LocaleLink href="/sign-up" locale={locale}>
                {t("hero.secondaryCta")}
              </LocaleLink>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <LocaleLink href="/sign-in" locale={locale}>
                {t("hero.signInCta")}
              </LocaleLink>
            </Button>
          </div>

          {/* Product screenshot — the prominent hero visual. */}
          <div className="relative mt-10 w-full max-w-5xl">
            <div
              aria-hidden
              className="from-primary/25 absolute -inset-x-6 top-8 -bottom-6 -z-10 rounded-[2rem] bg-gradient-to-tr to-transparent opacity-60 blur-3xl"
            />
            <div className="border-border bg-card overflow-hidden rounded-xl border shadow-2xl">
              <Image
                src={heroScreenshot}
                alt={t("hero.screenshotAlt")}
                width={1200}
                height={1003}
                priority
                // Already an optimized 1200px-wide AVIF — serve it as-is instead
                // of re-encoding (and softening the small UI text) through the
                // image optimizer.
                unoptimized
                className="h-auto w-full"
              />
            </div>
          </div>

          <dl className="border-border bg-border mt-12 grid w-full grid-cols-2 gap-px overflow-hidden rounded-xl border sm:grid-cols-3 md:grid-cols-5">
            {stats.map((s) => (
              <div key={s.label} className="bg-card px-4 py-5 text-center">
                <dt className="text-2xl font-semibold tracking-tight">{s.value}</dt>
                <dd className="text-muted-foreground mt-1 text-xs">{s.label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ------------------------------------------------------------ Features */}
      <section aria-labelledby="features-heading" className="mx-auto max-w-6xl px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
            {t("features.eyebrow")}
          </p>
          <h2
            id="features-heading"
            className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
          >
            {t("features.title")}
          </h2>
          <p className="text-muted-foreground mt-4 text-pretty">{t("features.subtitle")}</p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => {
            const Icon = FEATURE_ICONS[i % FEATURE_ICONS.length]!;
            return (
              <div key={f.title} className="border-border bg-card rounded-xl border p-5">
                <div className="bg-muted text-foreground flex h-10 w-10 items-center justify-center rounded-lg">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <h3 className="mt-4 text-base font-semibold">{f.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm text-pretty">{f.description}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ----------------------------------------------------------------- Why */}
      <section aria-labelledby="why-heading" className="border-border bg-muted/40 border-y">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
              {t("why.eyebrow")}
            </p>
            <h2
              id="why-heading"
              className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
            >
              {t("why.title")}
            </h2>
            <p className="text-muted-foreground mt-4 text-pretty">{t("why.subtitle")}</p>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {whyItems.map((w) => (
              <div key={w.title} className="border-border bg-card rounded-xl border p-6">
                <div className="flex items-center gap-2">
                  <Check className="text-primary h-5 w-5 shrink-0" aria-hidden />
                  <h3 className="text-base font-semibold">{w.title}</h3>
                </div>
                <p className="text-muted-foreground mt-3 text-sm text-pretty">{w.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- Stack */}
      <section aria-labelledby="stack-heading" className="mx-auto max-w-5xl px-6 py-20 text-center">
        <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
          {t("stack.eyebrow")}
        </p>
        <h2
          id="stack-heading"
          className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
        >
          {t("stack.title")}
        </h2>
        <ul className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {stack.map((s) => (
            <li
              key={s}
              className="border-border bg-card text-muted-foreground rounded-full border px-4 py-1.5 text-sm"
            >
              {s}
            </li>
          ))}
        </ul>
      </section>

      {/* ----------------------------------------------------------- Final CTA */}
      <section aria-labelledby="cta-heading" className="mx-auto w-full max-w-6xl px-6 pb-24">
        <div className="border-border bg-card relative overflow-hidden rounded-2xl border px-6 py-16 text-center">
          <div
            aria-hidden
            className="from-primary/10 pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent"
          />
          <div className="relative mx-auto max-w-2xl">
            <h2
              id="cta-heading"
              className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
            >
              {t("cta.title")}
            </h2>
            <p className="text-muted-foreground mt-4 text-pretty">{t("cta.subtitle")}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg">
                <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                  <GithubIcon className="h-4 w-4" />
                  {t("cta.primary")}
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <LocaleLink href="/sign-up" locale={locale}>
                  {t("cta.secondary")}
                </LocaleLink>
              </Button>
            </div>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground mt-6 inline-flex items-center gap-1.5 text-sm"
            >
              <GithubIcon className="h-4 w-4" />
              {t("cta.repoLabel")}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- Footer */}
      <footer className="border-border border-t">
        <div className="text-muted-foreground mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-sm sm:flex-row">
          <p>{t("footer.rights")}</p>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground inline-flex items-center gap-1.5"
          >
            <GithubIcon className="h-4 w-4" />
            {t("footer.githubLink")}
          </a>
        </div>
      </footer>
    </main>
  );
}
