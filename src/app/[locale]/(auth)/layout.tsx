import type { ReactNode } from "react";

/**
 * AuthLayout
 *
 * Wrapper for all authentication routes under `/[locale]/(auth)/`.
 * Applies comfortable density. Per §28.3, auth pages must not render
 * the secure navigation shell or hydrate secure shell state.
 *
 * Layout: normal document scrolling; no viewport-bounded shell.
 * Accessibility: each auth page owns its own `<main>` landmark.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  // Comfortable density for auth forms per §3.8.
  return <div data-density="comfortable">{children}</div>;
}
