import type { ReactNode } from "react";

/**
 * Breadcrumbs
 *
 * Server Component that renders a navigational breadcrumb trail.
 * Wraps items in a `<nav>` with `aria-label="Breadcrumb"` so it is
 * surfaced as a distinct landmark by assistive technologies.
 *
 * Each item should be a link except the last (current page), which
 * receives `aria-current="page"`.
 */
export function Breadcrumbs({ children }: { children: ReactNode }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex items-center gap-1 text-sm text-neutral-500">{children}</ol>
    </nav>
  );
}
