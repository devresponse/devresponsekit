"use client";

import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { useTheme } from "@/components/theme/theme-provider";
import { useTranslations } from "next-intl";
import { DiagramModal } from "./diagram-modal";
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
 * Each rendered diagram is then made interactive: clicking (or pressing
 * Enter/Space on) it opens {@link DiagramModal}, a full-view lightbox —
 * inline diagrams are often too small to read on a large screen. The open
 * handler is delegated from the article root so it survives theme
 * re-renders without rebinding per diagram.
 */
const MERMAID_SELECTOR = '.mermaid[data-rendered="true"]';

export function DocArticle({ html, space = "docs" }: { html: string; space?: DocSpace }) {
  const ref = useRef<HTMLElement>(null);
  const { resolvedTheme } = useTheme();
  const t = useTranslations(space);
  // Latest translator without forcing the render effect to re-run on every
  // render (which would re-import and re-render Mermaid needlessly).
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  const [diagramSvg, setDiagramSvg] = useState<string | null>(null);

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
  // many diagrams the document has or how often they re-render.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const openFrom = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest<HTMLElement>(MERMAID_SELECTOR) : null;
      if (el) setDiagramSvg(el.innerHTML);
    };
    const onClick = (e: MouseEvent) => openFrom(e.target);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target instanceof Element && e.target.closest(MERMAID_SELECTOR)) {
        e.preventDefault();
        openFrom(e.target);
      }
    };

    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <>
      <article
        ref={ref}
        className="prose prose-sm dark:prose-invert max-w-none"
        // Safe: `html` is sanitized by rehype-sanitize in the render pipeline
        // (scripts, handlers, and dangerous URLs removed) before it reaches here.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {diagramSvg !== null ? (
        <DiagramModal svg={diagramSvg} onClose={() => setDiagramSvg(null)} space={space} />
      ) : null}
    </>
  );
}
