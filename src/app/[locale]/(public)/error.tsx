"use client";

import { RouteError } from "@/components/observability/route-error";

/**
 * Error boundary for the (public) route group (landing, status pages, …).
 * It keeps a render error here localized and captured to Sentry with a
 * quotable Support ID, inside the locale shell and the group's layout
 * (P2-13). A throw from (public)/layout.tsx itself is caught one level up,
 * by [locale]/error.tsx (F-68).
 */
export default function PublicError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}
