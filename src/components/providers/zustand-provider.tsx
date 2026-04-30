"use client";

import type { ReactNode } from "react";

/**
 * ZustandProvider
 *
 * Client Component boundary that ensures Zustand stores are initialized
 * on the client. In Next.js App Router, Zustand stores that persist via
 * `localStorage` must be initialized inside a Client Component so that
 * `typeof window` checks work correctly during SSR.
 *
 * Hydration safety: stores that use `createJSONStorage(() => window.localStorage)`
 * guard against SSR by checking `typeof window !== "undefined"`. This
 * provider exists as a named slot in the provider tree for future store
 * initialization that may need explicit reset-on-unmount behavior.
 *
 * Persistence safety: Zustand stores MUST NOT persist auth tokens, session
 * ids, role decisions, or any authority-bearing data to localStorage.
 * Only layout preferences (sidebar visibility, density) are safe to persist.
 */
export function ZustandProvider({ children }: { children: ReactNode }) {
  // No setup needed currently — stores initialize themselves on first access.
  return <>{children}</>;
}
