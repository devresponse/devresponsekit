import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * ShellFooter
 *
 * Server Component. Wraps the shell footer region as a `<footer>`
 * landmark with `role="contentinfo"`. Visibility is parent-controlled
 * and defaults visible per spec §17.5; when hidden the wrapper is not
 * rendered at all.
 *
 * Layout: height is driven by the `--sh-foot-h` CSS variable on
 * `.sh-grid` and shrinks for nested shells per spec §17.2.
 */
export function ShellFooter({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <footer className={cn("sh-footer", className)} role="contentinfo">
      {children}
    </footer>
  );
}
