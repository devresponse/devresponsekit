"use client";

import { useAppShellStore } from "@/stores/app-shell-store";

/**
 * MobileSidebarTrigger
 *
 * Client Component button that toggles the left sidebar visibility on
 * small viewports. Reads and mutates the `root` scope in the app-shell
 * Zustand store; the store is safe for `localStorage` persistence because
 * it stores only layout preferences, never auth data.
 *
 * Accessibility: the button exposes `aria-expanded` so assistive
 * technologies announce the current state of the sidebar.
 */
export function MobileSidebarTrigger({ scope = "root" }: { scope?: "root" | "workspace" }) {
  const leftVisible = useAppShellStore((s) => s.visibility[scope].leftVisible);
  const toggle = useAppShellStore((s) => s.toggleRegion);

  return (
    <button
      type="button"
      aria-expanded={leftVisible}
      aria-label={leftVisible ? "Hide sidebar" : "Show sidebar"}
      onClick={() => toggle(scope, "left")}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-neutral-100"
    >
      {/* Hamburger / close icon rendered via CSS content */}
      <span className="sr-only">{leftVisible ? "Hide sidebar" : "Show sidebar"}</span>
      <svg
        aria-hidden="true"
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        {leftVisible ? (
          // X icon when sidebar is open
          <>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </>
        ) : (
          // Hamburger icon when sidebar is closed
          <>
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </>
        )}
      </svg>
    </button>
  );
}
