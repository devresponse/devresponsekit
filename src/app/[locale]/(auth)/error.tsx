"use client";

import { RouteError } from "@/components/observability/route-error";

/**
 * Error boundary for the (auth) route group (sign-in, sign-up, password
 * reset, …). It keeps a render error here localized and captured to Sentry
 * with a quotable Support ID, inside the locale shell (P2-13).
 */
export default function AuthError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}
