"use client";

import { useTranslations } from "next-intl";
import { LightboxModal } from "./lightbox-modal";
import type { DocSpace } from "@/lib/docs/source/types";

/**
 * ImageModal
 *
 * Full-view lightbox for an image embedded in a document (e.g. the help
 * walkthrough's screenshots). Inline images are scaled down to the prose
 * column, so clicking one opens it in the shared {@link LightboxModal} at
 * (almost) the whole viewport with zoom controls. The image's alt text
 * doubles as the dialog title when present.
 */
export function ImageModal({
  src,
  alt,
  onClose,
  space = "docs",
}: {
  src: string;
  alt: string;
  onClose: () => void;
  space?: DocSpace;
}) {
  const t = useTranslations(space);
  return (
    <LightboxModal
      title={alt || t("image.title")}
      description={t("image.expand")}
      onClose={onClose}
      space={space}
    >
      {(zoom) => (
        <div style={{ width: `${zoom * 100}%` }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the source
              is the auth-gated asset route (relative URL, private caching);
              next/image's optimizer must not proxy or cache it. */}
          <img src={src} alt={alt} className="w-full" />
        </div>
      )}
    </LightboxModal>
  );
}
