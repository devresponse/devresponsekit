import type { ReactNode } from "react";

/**
 * PublicLayout
 *
 * Wrapper for all public (unauthenticated) routes under `/[locale]/(public)/`.
 * Applies comfortable density so form fields and copy read well at normal size.
 *
 * This layout intentionally does NOT:
 *   - Call any secure menu API.
 *   - Hydrate the app-shell Zustand store.
 *   - Require a session cookie.
 *
 * Per §28.2, public routes may render a lightweight public shell only.
 * Normal document scrolling is allowed (not viewport-bounded).
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  // Comfortable density is the default for unauthenticated surfaces (§3.8).
  return <div data-density="comfortable">{children}</div>;
}
