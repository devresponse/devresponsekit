"use client";

import { useState, type ReactNode } from "react";
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
 * LightboxModal
 *
 * The shared full-view shell behind {@link DiagramModal} and
 * {@link ImageModal}: a near-viewport dialog with zoom controls. Zoom is
 * width-based — `children` receives the current zoom factor and renders a
 * wrapper sized to `zoom * 100%` while the body scrolls — so panning a
 * zoomed diagram/image works with native scrollbars. Built on the shared
 * Dialog primitive, which provides the focus trap, Escape-to-close,
 * backdrop, and close button. The zoom-control labels come from the
 * space's `diagram.*` keys (they are generic "Zoom in/out/reset" strings).
 */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const STEP = 0.25;

const clampZoom = (value: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));

export function LightboxModal({
  title,
  description,
  onClose,
  space = "docs",
  children,
}: {
  title: string;
  /** Screen-reader-only dialog description. */
  description: string;
  onClose: () => void;
  space?: DocSpace;
  /** Renders the zoomed content; receives the current zoom factor. */
  children: (zoom: number) => ReactNode;
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
          <DialogTitle className="truncate text-sm font-semibold">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
          <div className="flex shrink-0 items-center gap-1 pr-9">
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
        <div className="bg-muted/30 overflow-auto p-4">{children(zoom)}</div>
      </DialogContent>
    </Dialog>
  );
}
