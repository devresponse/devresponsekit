"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * Returns `false` on the server and during the first client render, then
 * `true` after hydration (P2-2).
 *
 * Use it to defer rendering any value that differs between the server
 * (which sees defaults) and the client (which can read browser-only state,
 * such as the runtime's time-zone list, synchronously). Reading that value
 * directly on first render makes the markup disagree with the SSR output →
 * a React hydration warning + a visible flicker.
 *
 * Implemented with `useSyncExternalStore` (server snapshot `false`, client
 * snapshot `true`) so there is no in-effect `setState`.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
