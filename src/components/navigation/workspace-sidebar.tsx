import type { ReactNode } from "react";

/**
 * WorkspaceSidebar
 *
 * Server/Client Component for the workspace-level left sidebar. Used inside
 * the `ShellLeft` slot of the workspace `ApplicationShell`. Provides
 * workspace-scoped navigation links and section grouping.
 */
export function WorkspaceSidebar({ children }: { children?: ReactNode }) {
  return (
    <nav
      className="flex h-full flex-col overflow-y-auto py-4"
      aria-label="Workspace navigation"
    >
      {children}
    </nav>
  );
}
