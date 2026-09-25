"use client";

import * as React from "react";
import { MOBILE_MEDIA_QUERY } from "@/lib/breakpoints";

/**
 * `true` when the viewport is narrower than the `md` breakpoint.
 *
 * The query is the shared `MOBILE_MEDIA_QUERY`, the same string
 * `app-shell.css` hides the side columns with and the complement of
 * Tailwind's `md:` (F-36). It used to be its own `(max-width: 767px)`,
 * one pixel off the CSS, so at exactly 768px the rail was hidden while this
 * hook kept the desktop branch and the trigger had no drawer to open.
 *
 * Implemented with `useSyncExternalStore` rather than a lazy
 * `useState(getIsMobile)` (review #102): a lazy initializer runs again on
 * the client during HYDRATION, so on a narrow viewport the server markup
 * (which cannot read `window`) and the first client render disagreed —
 * a guaranteed hydration mismatch, a discarded shell render and a console
 * error on every mobile secure page. `useSyncExternalStore` is the only
 * hook that lets the first client render reuse the SERVER snapshot
 * (`false`) and then re-render from the store, which is exactly the
 * pattern `useHydrated` / the theme toggle already use.
 *
 * Consequence for callers: the first paint after hydration is always the
 * desktop branch, matching SSR. `Sidebar` therefore mounts its static
 * variant and swaps to the mobile Sheet in the same commit React uses for
 * every other post-hydration store read.
 */
function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/** Server (and first hydration) snapshot — `window` is unknowable there. */
function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
