import { cn } from "@/lib/utils";

/**
 * TopShellBar
 *
 * Sticky brand bar at the top of the root shell. Hosts the application
 * switcher trigger, locale switcher, and user menu. Server-compatible
 * by default; interactive children opt-in to "use client".
 *
 * Accessibility: rendered as a `header` landmark distinct from the
 * inner page header so screen readers can navigate to brand controls
 * separately from page-level controls.
 */
export function TopShellBar({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn("sh-top-bar gap-3 px-4", className)}
      role="banner"
      aria-label="Application brand bar"
    >
      {children}
    </header>
  );
}
