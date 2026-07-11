"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DocSpace } from "@/lib/docs/source/types";

/**
 * DiagramModal
 *
 * Full-view lightbox for a rendered Mermaid diagram. Inline diagrams are
 * often too small to read on a large screen, so clicking one opens it here
 * scaled to (almost) the whole viewport, with zoom controls. Zoom is
 * width-based — the inner wrapper grows to `zoom * 100%` and the body
 * scrolls — so panning a zoomed diagram works with native scrollbars.
 *
 * The SVG is the SAME markup already rendered inline (produced by Mermaid
 * with `securityLevel: "strict"`), so injecting it is safe. Built on the
 * shared Dialog primitive, which provides the focus trap, Escape-to-close,
 * backdrop, and close button.
 */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const STEP = 0.25;

const clampZoom = (value: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));

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
  const [zoom, setZoom] = useState(1);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="grid h-[92vh] w-[96vw] max-w-[96vw] grid-rows-[auto_1fr] gap-0 overflow-hidden p-0">
        <DialogHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b px-4 py-2 text-left">
          <DialogTitle className="text-sm font-semibold">{t("diagram.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("diagram.expand")}</DialogDescription>
          <div className="flex items-center gap-1 pr-9">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={t("diagram.zoomOut")}
              disabled={zoom <= MIN_ZOOM}
              onClick={() => setZoom((z) => clampZoom(z - STEP))}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="text-muted-foreground w-12 text-center text-xs tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={t("diagram.zoomIn")}
              disabled={zoom >= MAX_ZOOM}
              onClick={() => setZoom((z) => clampZoom(z + STEP))}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={t("diagram.reset")}
              onClick={() => setZoom(1)}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>
        <div className="bg-muted/30 overflow-auto p-4">
          <div
            className="diagram-modal-svg origin-top-left"
            style={{ width: `${zoom * 100}%` }}
            // Safe: this SVG was produced by Mermaid (securityLevel "strict")
            // and is the same markup already rendered in the sanitized article.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
