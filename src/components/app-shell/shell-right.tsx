import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * ShellRight
 *
 * Server Component. Wraps the right inspector region as an `<aside>`
 * landmark labelled "Inspector". Visibility is parent-controlled and
 * defaults visible per spec §17.5; when hidden the wrapper is not
 * rendered at all.
 *
 * Layout: width is driven by the `--sh-right-w` CSS variable on
 * `.sh-grid` and shrinks for nested shells per spec §17.2.
 */
export function ShellRight({
  children,
  className,
  ariaLabel = "Inspector",
}: {
  children?: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <aside className={cn("sh-right", className)} aria-label={ariaLabel}>
      {children}
    </aside>
  );
}
