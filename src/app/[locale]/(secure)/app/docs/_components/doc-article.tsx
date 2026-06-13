/**
 * DocArticle
 *
 * Renders the SANITIZED HTML produced by the docs render pipeline inside
 * a Tailwind Typography (`prose`) container. The HTML has already been
 * through `rehype-sanitize` (scripts, event handlers, and dangerous URLs
 * removed), so `dangerouslySetInnerHTML` here is safe — the only inline
 * styles are the trusted Shiki theme variables. Server component.
 */
export function DocArticle({ html }: { html: string }) {
  return (
    <article
      className="prose prose-sm dark:prose-invert max-w-none"
      // Safe: `html` is sanitized by rehype-sanitize in the render pipeline
      // (scripts, handlers, and dangerous URLs removed) before it reaches here.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
