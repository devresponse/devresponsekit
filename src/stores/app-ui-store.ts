"use client";

import { create } from "zustand";

/**
 * App UI store.
 *
 * Manages transient UI state that is NOT shell-layout-related and should
 * NOT be persisted to `localStorage`.
 *
 * Persistence safety:
 *   - This store deliberately omits the `persist` middleware.
 *   - State resets on every page load, which is correct for transient UI
 *     (toast queue, modal state, command-palette open state).
 *   - MUST NOT store auth tokens, session ids, role data, or any
 *     authority-bearing information.
 *
 * Hydration: because there is no persistence, SSR and client initial state
 * are always identical — no hydration mismatch risk.
 *
 * Why client state: these values exist purely to coordinate ephemeral UI
 * interactions that would otherwise require drilling callbacks deeply
 * through the component tree.
 */
interface AppUiState {
  /** Whether the command palette (keyboard shortcut overlay) is open. */
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  /** Whether a global full-page loading spinner is visible. */
  globalLoading: boolean;
  setGlobalLoading: (loading: boolean) => void;
}

export const useAppUiStore = create<AppUiState>((set) => ({
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  globalLoading: false,
  setGlobalLoading: (loading) => set({ globalLoading: loading }),
}));
