import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * ShellMain
 *
 * Server Component. Wraps the `<main>` landmark for the shell content
 * region. The `ShellSkipLinks` "skip to main" anchor moves keyboard focus
 * here.
 *
 * Layout: owns its own scrolling per spec §17.4 — `.sh-main` uses
 * `overflow: auto` and `min-height: 0`. Long content must not push the
 * grid rows or columns.
 *
 * `tabIndex={0}` (not -1) keeps the scroll region operable by keyboard:
 * because `.sh-main` is itself the scroll container, a read-only page tall
 * enough to overflow (e.g. the account overview) would otherwise be a
 * scrollable region a keyboard user cannot reach or scroll — an axe
 * `scrollable-region-focusable` (WCAG 2.1.1) violation. 0 also still serves
 * as the skip-link target. Pages with focusable content are unaffected.
 *
 * `nested` picks the LANDMARK (review #104/#105). A document has exactly
 * one `main`: a nested `ApplicationShell` (Account, Administrator, Docs,
 * Help, Workspace) lives inside the root shell's `<main>`, so it renders a
 * labelled `<section>` — a `region` landmark, navigable by name, without
 * duplicating `main` or its `id`.
 */
export function ShellMain({
  children,
  className,
  id = "main",
  ariaLabel,
  nested = false,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  /** Accessible name for the landmark — helps distinguish the root vs a
   *  nested shell's main region for assistive tech. Required for a nested
   *  shell: an unlabelled `<section>` is not a landmark at all. */
  ariaLabel?: string;
  /** Render a labelled `<section>` instead of `<main>` (nested shells). */
  nested?: boolean;
}) {
  const Tag = nested ? "section" : "main";
  return (
    <Tag id={id} className={cn("sh-main", className)} tabIndex={0} aria-label={ariaLabel}>
      {children}
    </Tag>
  );
}
