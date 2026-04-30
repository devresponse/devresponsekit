import type { ReactNode } from "react";

/**
 * AppLayout
 *
 * Intermediate layout for all routes under `/[locale]/app/*`. This layout
 * sits between the `(secure)/layout.tsx` (which owns the shell frame and
 * auth guard) and the individual page routes (dashboard, workspace, admin).
 *
 * Keeping this layout minimal allows page-level layouts (e.g. workspace)
 * to add their own nested `ApplicationShell` without duplicating the root
 * shell setup.
 *
 * All routes under this layout are already protected by the parent
 * `(secure)/layout.tsx` — do NOT add additional auth redirects here.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
