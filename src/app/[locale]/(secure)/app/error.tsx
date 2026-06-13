"use client";

import { RouteError } from "@/components/observability/route-error";

/**
 * Error boundary for the entire authenticated app subtree (dashboard,
 * administrator, account, …). A render error here replaces only the
 * content region — the locale shell and providers above stay mounted —
 * and is captured to Sentry with a quotable Support ID.
 *
 * This is the concrete realization of the "AdministratorErrorBoundary"
 * referenced in docs/admin-manager.md §12 (broadened to cover every
 * secure workspace, not just the administrator app).
 */
export default function SecureAppError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}
