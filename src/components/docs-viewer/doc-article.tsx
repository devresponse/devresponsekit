"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { useTheme } from "@/components/theme/theme-provider";
import { useTranslations } from "next-intl";
import { DiagramModal } from "./diagram-modal";
import { ImageModal } from "./image-modal";
import type { DocSpace } from "@/lib/docs/source/types";

/**
 * DocArticle
 *
 * Renders the SANITIZED HTML produced by the docs render pipeline inside
 * a Tailwind Typography (`prose`) container. The HTML has already been
 * through `rehype-sanitize` (scripts, event handlers, and dangerous URLs
 * removed), so `dangerouslySetInnerHTML` here is safe — the only inline
 * styles are the trusted Shiki theme variables.
 *
 * Mermaid blocks arrive as `<div class="mermaid">` mounts whose text is
 * the raw diagram source (the pipeline extracts ```mermaid fences before
 * the syntax highlighter). We lazily import Mermaid ONLY when such a mount
 * exists, render each to SVG with `securityLevel: "strict"`, sanitize that SVG
 * with DOMPurify before injecting it, re-render on theme change, and fall back
 * to source on error.
 *
 * Each rendered diagram — and every embedded image (except ones wrapped in
 * a link, whose click must keep navigating) — is made an interactive
 * "expand" control that opens a full-view lightbox: inline diagrams and
 * the help walkthrough's screenshots are scaled well below their true size
 * in the prose column.
 *
 * SPLIT ARCHITECTURE (load-bearing): the article body lives in a memoized
 * {@link ArticleBody}. The decoration/render effects mutate the DOM that
 * `dangerouslySetInnerHTML` owns, and React re-commits that innerHTML —
 * wiping every mutation — on ANY re-render of the element. So the modal
 * open/close state MUST NOT live in the same component as the article, or
 * opening a lightbox would strip the very decorations that make the next
 * click work. `ArticleBody`'s props (html, space, stable callbacks) don't
 * change when a modal toggles, so `memo` keeps it from re-rendering;
 * theme changes still re-render it through context (to re-theme Mermaid).
 */
const MERMAID_SELECTOR = '.mermaid[data-rendered="true"]';
const LIGHTBOX_IMG_SELECTOR = 'img[data-lightbox="true"]';

interface ImageView {
  src: string;
  alt: string;
}

const ArticleBody = memo(function ArticleBody({
  html,
  space,
  onOpenDiagram,
  onOpenImage,
}: {
  html: string;
  space: DocSpace;
  onOpenDiagram: (svg: string) => void;
  onOpenImage: (view: ImageView) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const { resolvedTheme } = useTheme();
  const t = useTranslations(space);
  // Latest translator without forcing the render effect to re-run on every
  // render (which would re-import and re-render Mermaid needlessly).
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  // Expose every embedded image as an "expand" control. Images inside a
  // link are left alone — their click must keep following the link.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
      if (img.closest("a") || img.closest(".mermaid")) continue;
      img.dataset.lightbox = "true";
      img.setAttribute("role", "button");
      img.setAttribute("tabindex", "0");
      img.setAttribute(
        "aria-label",
        img.alt ? `${img.alt} — ${tRef.current("image.expand")}` : tRef.current("image.expand"),
      );
      img.classList.add("cursor-zoom-in");
    }
  }, [html]);

  // Render Mermaid mounts to SVG and make each one an interactive control.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const mounts = Array.from(root.querySelectorAll<HTMLElement>(".mermaid"));
    if (mounts.length === 0) return;

    let cancelled = false;
    void (async () => {
      const mermaid = (await import("mermaid")).default;
      if (cancelled) return;

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: resolvedTheme === "dark" ? "dark" : "default",
      });

      for (let i = 0; i < mounts.length; i++) {
        const el = mounts[i]!;
        const source = el.dataset.src ?? el.textContent ?? "";
        el.dataset.src = source;
        try {
          const { svg } = await mermaid.render(`mmd-${i}-${source.length}`, source);
          if (cancelled) return;
          // Defense in depth + the explicit sanitizer the CodeQL `js/xss-through-dom`
          // flow requires (the diagram source is read from the DOM as text). DOMPurify
          // still strips `<script>`, event handlers, and `javascript:` URLs regardless.
          // This config MIRRORS Mermaid's own internal SVG-sanitize config, so the pass
          // is idempotent and never blanks diagram text: Mermaid renders node/edge labels
          // as HTML inside `<foreignObject>`, which DOMPurify only keeps when that element
          // is allowed AND marked an HTML integration point (its content stays HTML, not
          // SVG). Dropping these — e.g. an `svg`-only profile — strips every label.
          el.innerHTML = DOMPurify.sanitize(svg, {
            ADD_TAGS: ["foreignobject"],
            ADD_ATTR: ["dominant-baseline"],
            HTML_INTEGRATION_POINTS: { foreignobject: true },
          });
          el.dataset.rendered = "true";
          // Expose the diagram as a button that opens the full view.
          el.setAttribute("role", "button");
          el.setAttribute("tabindex", "0");
          el.setAttribute("aria-label", tRef.current("diagram.expand"));
        } catch {
          if (cancelled) return;
          el.textContent = source;
          el.dataset.rendered = "error";
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [html, resolvedTheme]);

  // Delegated open handler — one listener on the root, regardless of how
  // many diagrams/images the document has or how often they re-render.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const openFrom = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      const diagram = target.closest<HTMLElement>(MERMAID_SELECTOR);
      if (diagram) {
        onOpenDiagram(diagram.innerHTML);
        return true;
      }
      const img = target.closest<HTMLImageElement>(LIGHTBOX_IMG_SELECTOR);
      if (img) {
        onOpenImage({ src: img.currentSrc || img.src, alt: img.alt });
        return true;
      }
      return false;
    };
    const onClick = (e: MouseEvent) => openFrom(e.target);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (openFrom(e.target)) e.preventDefault();
    };

    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [onOpenDiagram, onOpenImage]);

  return (
    <article
      ref={ref}
      className="prose prose-sm dark:prose-invert max-w-none"
      // Safe: `html` is sanitized by rehype-sanitize in the render pipeline
      // (scripts, handlers, and dangerous URLs removed) before it reaches here.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export function DocArticle({ html, space = "docs" }: { html: string; space?: DocSpace }) {
  const [diagramSvg, setDiagramSvg] = useState<string | null>(null);
  const [imageView, setImageView] = useState<ImageView | null>(null);

  // Stable callbacks so ArticleBody's props never change on a modal toggle —
  // see the note on the split architecture above.
  const onOpenDiagram = useCallback((svg: string) => setDiagramSvg(svg), []);
  const onOpenImage = useCallback((view: ImageView) => setImageView(view), []);

  return (
    <>
      <ArticleBody
        html={html}
        space={space}
        onOpenDiagram={onOpenDiagram}
        onOpenImage={onOpenImage}
      />
      {diagramSvg !== null ? (
        <DiagramModal svg={diagramSvg} onClose={() => setDiagramSvg(null)} space={space} />
      ) : null}
      {imageView !== null ? (
        <ImageModal
          src={imageView.src}
          alt={imageView.alt}
          onClose={() => setImageView(null)}
          space={space}
        />
      ) : null}
    </>
  );
}
