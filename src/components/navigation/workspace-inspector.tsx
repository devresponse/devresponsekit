import type { ReactNode } from "react";

/**
 * WorkspaceInspector
 *
 * Server/Client Component stub for the workspace-level right inspector
 * panel. Rendered inside the `ShellRight` slot of a nested
 * `ApplicationShell`.
 */
export function WorkspaceInspector({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      {children ?? (
        <p className="text-xs text-neutral-400">Workspace inspector</p>
      )}
    </div>
  );
}
