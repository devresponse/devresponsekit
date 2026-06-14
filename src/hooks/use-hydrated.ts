"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * Returns `false` on the server and during the first client render, then
 * `true` after hydration (P2-2).
 *
 * Use it to defer rendering any value that differs between the server
 * (which sees store defaults) and the client (which rehydrates persisted
 * Zustand / localStorage state synchronously). Reading the persisted value
 * directly on first render makes `aria-pressed`/labels disagree with the
 * SSR markup → a React hydration warning + a visible flicker.
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
