import { cn } from "@/lib/cn";
import type { ShellSlotProps } from "./shell-types";

/**
 * ShellHeader
 *
 * Header slot for the Holy Grail shell grid. Server-compatible.
 * Renders a `<header>` element with the `sh-header` CSS class so the
 * parent `ShellGridContainer` places it in the correct grid row.
 *
 * Accessibility: landmark role `banner` is provided by the `<header>`
 * element when it is a descendant of `<body>` or an `<article>`, `<aside>`,
 * `<main>`, `<nav>`, or `<section>` element.
 */
export function ShellHeader({ children, className }: ShellSlotProps) {
  return (
    <header className={cn("sh-header", className)} role="banner">
      {children}
    </header>
  );
}
