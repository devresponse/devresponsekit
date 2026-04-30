import type { ReactNode } from "react";

/**
 * PrimarySidebar
 *
 * Server/Client Component stub for the primary left navigation sidebar.
 * Rendered inside the `ShellLeft` slot of the root `ShellContainer`.
 *
 * Navigation items should be passed as children from the enclosing secure
 * layout after the server-side menu API has resolved.
 */
export function PrimarySidebar({ children }: { children?: ReactNode }) {
  return (
    <nav className="flex h-full flex-col overflow-y-auto py-4" aria-label="Primary navigation">
      {children}
    </nav>
  );
}
