import type { ReactNode } from "react";

/**
 * UserMenu
 *
 * Client Component stub for the authenticated user dropdown menu.
 * Displays user avatar, display name, and quick actions (profile,
 * sign out). Renders inside the `TopShellBar` on secure routes.
 *
 * Security: must not expose role information in the menu label.
 */
export function UserMenu({ children }: { children?: ReactNode }) {
  return (
    <div className="relative">
      {children ?? (
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-200 text-xs font-medium"
          aria-label="User menu"
        >
          U
        </button>
      )}
    </div>
  );
}
