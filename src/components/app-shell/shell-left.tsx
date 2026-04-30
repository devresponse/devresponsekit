import { cn } from "@/lib/cn";
import type { ShellSlotProps } from "./shell-types";

/**
 * ShellLeft
 *
 * Left sidebar slot for the Holy Grail shell grid. Server-compatible.
 * Renders an `<aside>` element with the `sh-left` CSS class.
 * The parent `ShellGridContainer` controls visibility; this component
 * only provides the semantic wrapper.
 *
 * Accessibility: uses `aria-label="Primary navigation"` by default so
 * the landmark is distinguishable from the inspector aside.
 */
export function ShellLeft({ children, className }: ShellSlotProps) {
  return (
    <aside className={cn("sh-left", className)} aria-label="Primary navigation" id="navigation">
      {children}
    </aside>
  );
}
