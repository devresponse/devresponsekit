"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

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
 * exists — so docs without diagrams never pay for the (large) library —
 * render each to SVG with `securityLevel: "strict"`, and re-render on
 * theme change. The original source is stashed in `data-src` so a failed
 * render (or a theme re-render) can fall back to readable text.
 */
export function DocArticle({ html }: { html: string }) {
  const ref = useRef<HTMLElement>(null);
  const { resolvedTheme } = useTheme();

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
        // Capture the source once; subsequent (theme) re-renders reuse it.
        const source = el.dataset.src ?? el.textContent ?? "";
        el.dataset.src = source;
        try {
          const { svg } = await mermaid.render(`mmd-${i}-${source.length}`, source);
          if (cancelled) return;
          el.innerHTML = svg;
          el.dataset.rendered = "true";
        } catch {
          if (cancelled) return;
          // Fallback: show the source as plain text rather than a broken box.
          el.textContent = source;
          el.dataset.rendered = "error";
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [html, resolvedTheme]);

  return (
    <article
      ref={ref}
      className="prose prose-sm dark:prose-invert max-w-none"
      // Safe: `html` is sanitized by rehype-sanitize in the render pipeline
      // (scripts, handlers, and dangerous URLs removed) before it reaches here.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
