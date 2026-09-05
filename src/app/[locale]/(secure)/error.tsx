"use client";

import { RouteError } from "@/components/observability/route-error";

/**
 * Error boundary at the (secure) GROUP level. The existing
 * (secure)/app/error.tsx only catches errors thrown by pages under /app/*;
 * this one covers the whole (secure) subtree BELOW (secure)/layout.tsx, so
 * a throw from any nested layout or page in the group renders the localized
 * RouteError instead of the English-only global-error.tsx (P2-13).
 *
 * NOTE (review #31): a segment's error.tsx cannot catch throws from its OWN
 * segment's layout. (secure)/layout.tsx fetches the session + the user's
 * organizations, and a failure there still lands on global-error.tsx —
 * catching it would need an error.tsx in the parent [locale] segment, which
 * does not exist today.
 */
export default function SecureError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}
