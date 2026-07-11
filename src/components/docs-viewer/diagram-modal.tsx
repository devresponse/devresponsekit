"use client";

import { useTranslations } from "next-intl";
import { LightboxModal } from "./lightbox-modal";
import type { DocSpace } from "@/lib/docs/source/types";

/**
 * DiagramModal
 *
 * Full-view lightbox for a rendered Mermaid diagram. Inline diagrams are
 * often too small to read on a large screen, so clicking one opens it in
 * the shared {@link LightboxModal} scaled to (almost) the whole viewport,
 * with zoom controls.
 *
 * The SVG is the SAME markup already rendered inline (produced by Mermaid
 * with `securityLevel: "strict"`), so injecting it is safe.
 */
export function DiagramModal({
  svg,
  onClose,
  space = "docs",
}: {
  svg: string;
  onClose: () => void;
  space?: DocSpace;
}) {
  const t = useTranslations(space);
  return (
    <LightboxModal
      title={t("diagram.title")}
      description={t("diagram.expand")}
      onClose={onClose}
      space={space}
    >
      {(zoom) => (
        <div
          className="diagram-modal-svg origin-top-left"
          style={{ width: `${zoom * 100}%` }}
          // Safe: this SVG was produced by Mermaid (securityLevel "strict")
          // and is the same markup already rendered in the sanitized article.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </LightboxModal>
  );
}
