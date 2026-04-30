import type { ReactNode } from "react";

/**
 * GlobalFooter
 *
 * Server Component for the site-wide footer rendered on public pages.
 * Provides copyright information and navigation links. Does not load
 * any secure menu APIs.
 */
export function GlobalFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="border-t px-6 py-4 text-sm text-neutral-500" role="contentinfo">
      {children ?? (
        <p>© {new Date().getFullYear()} DevResponse. All rights reserved.</p>
      )}
    </footer>
  );
}
