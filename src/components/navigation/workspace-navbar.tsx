import type { ReactNode } from "react";

/**
 * WorkspaceNavbar
 *
 * Server Component for the workspace-level top bar rendered inside the
 * `ShellHeader` slot of a nested `ApplicationShell`. Provides workspace
 * title, breadcrumbs, and quick actions.
 */
export function WorkspaceNavbar({ children }: { children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      {children}
    </div>
  );
}
