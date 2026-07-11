import { getTranslations } from "next-intl/server";
import { LocaleLink } from "@/components/i18n/locale-link";
import type { DocSpace } from "@/lib/docs/source/types";

/**
 * DocsBreadcrumbs
 *
 * Path context for a document: `<Space home> / <Group> / <Title>`. This
 * is navigation context, NOT a back-link — every form-free reading page
 * still needs a way back to the index, and breadcrumbs are the
 * conventional, accessible affordance. Server component (no interactivity).
 */
export async function DocsBreadcrumbs({
  locale,
  group,
  title,
  space = "docs",
}: {
  locale: string;
  group?: string;
  title: string;
  space?: DocSpace;
}) {
  const t = await getTranslations({ locale, namespace: space });
  return (
    <nav aria-label="Breadcrumb" className="text-muted-foreground mb-4 text-sm">
      <ol className="flex flex-wrap items-center gap-1.5">
        <li>
          <LocaleLink
            href={`/app/${space}` as "/"}
            locale={locale}
            className="hover:text-foreground underline-offset-2 hover:underline"
          >
            {t("breadcrumbHome")}
          </LocaleLink>
        </li>
        {group ? (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true">/</span>
            <span>{group}</span>
          </li>
        ) : null}
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true">/</span>
          <span className="text-foreground font-medium" aria-current="page">
            {title}
          </span>
        </li>
      </ol>
    </nav>
  );
}
