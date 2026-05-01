import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * ShellHeader
 *
 * Server Component. Thin wrapper around the `<header>` landmark used as
 * the page-level header inside the shell grid (distinct from the brand
 * `TopShellBar` which lives above the grid). Visual styling is owned by
 * the `.sh-header` class in `app-shell.css`.
 *
 * Accessibility: rendered with `role="banner"` to expose the header
 * region as a landmark to assistive technologies.
 */
export function ShellHeader({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("sh-header", className)} role="banner">
      {children}
    </header>
  );
}
