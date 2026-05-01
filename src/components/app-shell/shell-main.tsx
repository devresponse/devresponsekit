import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * ShellMain
 *
 * Server Component. Wraps the `<main>` landmark for the shell content
 * region. The element is focusable (`tabIndex={-1}`) so the
 * `ShellSkipLinks` "skip to main" anchor can move keyboard focus into
 * the page body.
 *
 * Layout: owns its own scrolling per spec §17.4 — `.sh-main` uses
 * `overflow: auto` and `min-height: 0`. Long content must not push the
 * grid rows or columns.
 */
export function ShellMain({
  children,
  className,
  id = "main",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <main id={id} className={cn("sh-main", className)} tabIndex={-1}>
      {children}
    </main>
  );
}
