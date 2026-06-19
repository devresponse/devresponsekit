"use client";

import { RouteError } from "@/components/observability/route-error";

/**
 * Error boundary at the (secure) GROUP level. The existing
 * (secure)/app/error.tsx only catches errors thrown by pages under /app/*.
 * The (secure)/layout.tsx fetches the session + the user's organizations
 * ABOVE that boundary, so a failure there would otherwise skip the
 * app-level boundary and hit the English-only global-error.tsx. This catches
 * those layout-level throws and keeps them localized (P2-13).
 */
export default function SecureError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}
