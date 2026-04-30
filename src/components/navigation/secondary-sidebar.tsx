import type { ReactNode } from "react";

/**
 * SecondarySidebar
 *
 * Server/Client Component stub for the secondary (workspace-level) left
 * navigation sidebar. Rendered inside the `ShellLeft` slot of a nested
 * `ApplicationShell`.
 *
 * Kept separate from `PrimarySidebar` so it can carry its own
 * `aria-label` distinct from the root sidebar landmark.
 */
export function SecondarySidebar({ children }: { children?: ReactNode }) {
  return (
    <nav className="flex h-full flex-col overflow-y-auto py-4" aria-label="Workspace navigation">
      {children}
    </nav>
  );
}
