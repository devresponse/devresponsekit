import { getTranslations } from "next-intl/server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Card, CardTitle } from "@/components/ui/card";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { getVisibleGroupedCatalog } from "@/lib/docs/catalog.server";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/help
 *
 * Help landing — the walkthrough catalog the caller may see, grouped.
 * Identical to the documentation landing but serving the `help` content
 * space. Read-only; visibility is enforced server-side by
 * `getVisibleGroupedCatalog` (the same filter that builds the sidebar),
 * so a document the caller cannot see never appears here and 404s if its
 * URL is guessed.
 */
export default async function HelpIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { access } = await requireSecureSession(locale, `/${locale}/app/help`);

  const groups = await getVisibleGroupedCatalog(access.permissions, "help");
  const t = await getTranslations({ locale, namespace: "help" });

  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("index.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("index.description")}</p>
      </div>

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("emptyCatalog")}</p>
      ) : (
        groups.map((group) => (
          <div key={group.group} className="space-y-3">
            <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {group.group}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.items.map((item) => (
                <LocaleLink
                  key={item.slug}
                  href={`/app/help/${item.slug}` as "/"}
                  locale={locale}
                  className="focus-visible:ring-ring rounded-lg focus-visible:ring-2 focus-visible:outline-none"
                >
                  <Card className="hover:border-primary/40 hover:bg-muted/40 flex h-full flex-col gap-1.5 p-4 transition-colors">
                    <CardTitle className="text-sm font-medium">{item.title}</CardTitle>
                    {item.description ? (
                      <p className="text-muted-foreground line-clamp-2 text-sm leading-snug">
                        {item.description}
                      </p>
                    ) : null}
                  </Card>
                </LocaleLink>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
