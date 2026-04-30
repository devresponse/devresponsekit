import { cn } from "@/lib/cn";
import type { ShellSlotProps } from "./shell-types";

/**
 * ShellFooter
 *
 * Footer slot for the Holy Grail shell grid. Server-compatible.
 * Renders a `<footer>` element with the `sh-footer` CSS class.
 * The parent `ShellGridContainer` controls visibility via `footerVisible`.
 *
 * Accessibility: landmark role `contentinfo` is provided by `<footer>`
 * when it is a direct descendant of `<body>`.
 */
export function ShellFooter({ children, className }: ShellSlotProps) {
  return (
    <footer className={cn("sh-footer", className)} role="contentinfo">
      {children}
    </footer>
  );
}
