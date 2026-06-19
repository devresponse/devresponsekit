"use client";

import { RouteError } from "@/components/observability/route-error";

/**
 * Error boundary for the (public) route group (landing, status pages, …).
 * Without it, a render error here escapes to the English-only root
 * global-error.tsx; this keeps the failure localized and captured to Sentry
 * with a quotable Support ID, inside the locale shell (P2-13).
 */
export default function PublicError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}
