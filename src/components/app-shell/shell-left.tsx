import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * ShellLeft
 *
 * Server Component. Wraps the left sidebar region as an `<aside>`
 * landmark labelled "Primary navigation" with `id="navigation"` so the
 * `ShellSkipLinks` skip-target works. Visibility is controlled by the
 * parent (typically `ShellGridContainer`); when hidden the wrapper is
 * not rendered at all.
 *
 * Layout: width is driven by the `--sh-left-w` CSS variable on
 * `.sh-grid` and shrinks for nested shells per spec §17.2.
 */
export function ShellLeft({
  children,
  className,
  ariaLabel = "Primary navigation",
  id = "navigation",
}: {
  children?: ReactNode;
  className?: string;
  ariaLabel?: string;
  id?: string;
}) {
  return (
    <aside className={cn("sh-left", className)} aria-label={ariaLabel} id={id}>
      {children}
    </aside>
  );
}
