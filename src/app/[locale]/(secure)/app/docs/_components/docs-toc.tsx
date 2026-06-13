import { getTranslations } from "next-intl/server";
import type { DocHeading } from "@/lib/docs/render/pipeline.server";

/**
 * DocsToc
 *
 * Right-rail "On this page" table of contents built from the headings the
 * render pipeline collected (depths 2–4). Each entry links to the
 * heading's anchor id. Server component — no scroll-spy in Phase 1, which
 * keeps it dependency-free and accessible. Renders nothing when the
 * document has no eligible headings.
 */
export async function DocsToc({ locale, headings }: { locale: string; headings: DocHeading[] }) {
  if (headings.length === 0) return null;
  const t = await getTranslations({ locale, namespace: "docs" });

  return (
    <nav aria-label={t("onThisPage")} className="text-sm">
      <p className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
        {t("onThisPage")}
      </p>
      <ul className="space-y-1">
        {headings.map((heading) => (
          <li key={heading.id} style={{ paddingLeft: `${(heading.depth - 2) * 0.75}rem` }}>
            <a
              href={`#${heading.id}`}
              className="text-muted-foreground hover:text-foreground block truncate underline-offset-2 hover:underline"
              title={heading.text}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
