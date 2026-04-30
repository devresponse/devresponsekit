import type { ReactNode } from "react";

/**
 * WorkspaceFooter
 *
 * Server Component for the footer bar rendered inside the workspace
 * `ApplicationShell` footer slot. Used for workspace-level status bars,
 * pagination controls, or secondary actions.
 */
export function WorkspaceFooter({ children }: { children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t px-4 py-1.5 text-xs text-neutral-500">
      {children}
    </div>
  );
}
