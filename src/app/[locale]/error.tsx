"use client";

import { RouteError } from "@/components/observability/route-error";

/**
 * Error boundary at the [locale] segment (F-68). A segment's error.tsx cannot
 * catch a throw from its own layout, so the route-group boundaries below it
 * ((secure), (auth), (public)) never covered their groups' layouts. The
 * clearest case is (secure)/layout.tsx, which reads the session and the user's
 * organizations on every render: a failure there fell through to the
 * English-only global-error.tsx. This boundary sits inside
 * [locale]/layout.tsx, so its providers are still mounted and the fallback is
 * the localized RouteError. Only a throw from [locale]/layout.tsx itself still
 * reaches global-error.tsx.
 *
 * The button gets Next's `retry`, not `reset`. What lands here is almost always
 * a server-side throw, and `reset` only clears the error state and re-renders
 * the cached payload, which still holds the error. `retry` re-fetches the
 * segment first (router.refresh), so "Try again" recovers once the failing read
 * does, as global-error.tsx's full reload did before this boundary existed.
 */
export default function LocaleError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} reset={retry} />;
}
