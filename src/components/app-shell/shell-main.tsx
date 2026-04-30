import { cn } from "@/lib/cn";
import type { ShellSlotProps } from "./shell-types";

/**
 * ShellMain
 *
 * Main content slot for the Holy Grail shell grid. Server-compatible.
 * Renders a `<main>` element with the `sh-main` CSS class and a default
 * `id="main"` so `ShellSkipLinks` can target it.
 *
 * Accessibility: `tabIndex={-1}` allows programmatic focus after a
 * skip-link activation without making the element keyboard-reachable.
 */
export function ShellMain({
  children,
  className,
  id = "main",
}: ShellSlotProps & { id?: string }) {
  return (
    <main id={id} className={cn("sh-main", className)} tabIndex={-1}>
      {children}
    </main>
  );
}
