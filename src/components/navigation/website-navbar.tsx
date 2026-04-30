import type { ReactNode } from "react";

/**
 * WebsiteNavbar
 *
 * Server Component for the primary marketing/public website navigation bar.
 * Shown on public pages (`(public)` route group). Does not call secure menu
 * APIs and does not require authentication.
 *
 * Layout: sticky to the top of the viewport for long-scrolling public pages.
 */
export function WebsiteNavbar({ children }: { children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-white/95 px-6 py-3 backdrop-blur" role="banner">
      <nav className="mx-auto flex max-w-5xl items-center justify-between" aria-label="Site navigation">
        {children}
      </nav>
    </header>
  );
}
