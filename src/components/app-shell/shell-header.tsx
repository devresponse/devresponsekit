import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * ShellHeader
 *
 * Server Component. Thin wrapper around the `<header>` element used as the
 * page-level header inside the shell grid (distinct from the brand
 * `TopShellBar` which lives above the grid). Visual styling is owned by
 * the `.sh-header` class in `app-shell.css`.
 *
 * Accessibility: this is NOT the site banner — `TopShellBar` is the single
 * `role="banner"` landmark. A nested shell's header renders inside the root
 * `<main>`, where a `<header>` has no implicit banner role, so we must not
 * force `role="banner"` here (two banners on one page is a WCAG/axe
 * `landmark-no-duplicate-banner` violation). Left as a plain `<header>`.
 */
export function ShellHeader({ children, className }: { children?: ReactNode; className?: string }) {
  return <header className={cn("sh-header", className)}>{children}</header>;
}
