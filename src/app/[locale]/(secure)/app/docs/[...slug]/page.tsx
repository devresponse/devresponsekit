import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { canViewDoc } from "@/lib/docs/catalog.server";
import { getDocumentSource } from "@/lib/docs/source/index.server";
import { renderDocument } from "@/lib/docs/render/pipeline.server";
import { DocArticle } from "../_components/doc-article";
import { DocsBreadcrumbs } from "../_components/docs-breadcrumbs";
import { DocsToc } from "../_components/docs-toc";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/docs/[...slug]
 *
 * Renders a single document. Security is layered:
 *   1. `requireSecureSession` — active user + membership (user-level).
 *   2. `canViewDoc` — per-doc visibility / `requires` filtering, so a
 *      hidden document 404s even if its URL is known.
 *   3. `getDocument` resolves the slug through the path-safe resolver;
 *      traversal/missing slugs return null → `notFound()`.
 *
 * The body is rendered server-side through the sanitizing pipeline; the
 * page never evaluates document JavaScript.
 */
export default async function DocPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string[] }>;
}) {
  const { locale: rawLocale, slug: slugParts } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { access } = await requireSecureSession(locale, `/${locale}/app/docs`);

  const slug = slugParts.join("/");

  if (!(await canViewDoc(slug, access.permissions))) notFound();

  const doc = await getDocumentSource().getDocument(slug);
  if (!doc) notFound();

  const { html, headings } = await renderDocument(doc.body, {
    locale,
    cacheKey: `${doc.entry.slug}|${doc.entry.updatedAt ?? ""}`,
  });

  const t = await getTranslations({ locale, namespace: "docs" });
  const updatedLabel = doc.entry.updatedAt
    ? t("lastUpdated", {
        date: new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
          new Date(doc.entry.updatedAt),
        ),
      })
    : null;

  return (
    <section className="mx-auto w-full max-w-5xl p-6">
      <DocsBreadcrumbs locale={locale} group={doc.entry.group} title={doc.entry.title} />
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_14rem] lg:gap-10">
        <div className="min-w-0">
          <DocArticle html={html} />
          {updatedLabel ? (
            <p className="text-muted-foreground mt-8 border-t pt-4 text-xs">{updatedLabel}</p>
          ) : null}
        </div>
        <aside className="mt-8 lg:mt-0">
          <div className="lg:sticky lg:top-16">
            <DocsToc locale={locale} headings={headings} />
          </div>
        </aside>
      </div>
    </section>
  );
}
