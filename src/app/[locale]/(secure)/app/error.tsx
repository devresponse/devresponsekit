"use client";

import { RouteError } from "@/components/observability/route-error";

/**
 * Error boundary for the entire authenticated app subtree (dashboard,
 * administrator, account, …). A render error here replaces only the
 * content region — the locale shell and providers above stay mounted —
 * and is captured to Sentry with a quotable Support ID. It covers every
 * secure workspace, not just the administrator app (review #165: the
 * "AdministratorErrorBoundary" this used to cite exists in no doc —
 * docs/admin-manager.md §12 is the audit model).
 */
export default function SecureAppError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}
