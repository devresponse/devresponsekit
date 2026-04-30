import { cn } from "@/lib/cn";
import type { ShellSlotProps } from "./shell-types";

/**
 * ShellRight
 *
 * Right inspector/panel slot for the Holy Grail shell grid. Server-compatible.
 * Renders an `<aside>` element with the `sh-right` CSS class.
 *
 * Accessibility: uses `aria-label="Inspector"` so this landmark is
 * distinguishable from the primary navigation aside.
 */
export function ShellRight({ children, className }: ShellSlotProps) {
  return (
    <aside className={cn("sh-right", className)} aria-label="Inspector">
      {children}
    </aside>
  );
}
