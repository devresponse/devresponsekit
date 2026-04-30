import type { ReactNode } from "react";

/**
 * InspectorPanel
 *
 * Server/Client Component stub for the right-side inspector panel inside
 * the `ShellRight` slot. Renders arbitrary detail content when provided
 * by a page-level layout.
 *
 * The parent `ShellGridContainer` controls visibility via `rightVisible`.
 */
export function InspectorPanel({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      {children ?? (
        <p className="text-sm text-neutral-400">Inspector</p>
      )}
    </div>
  );
}
