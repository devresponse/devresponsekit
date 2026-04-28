"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ShellRegion, ShellVisibilityScope } from "@/components/app-shell/shell-types";

interface RegionVisibilityState {
  leftVisible: boolean;
  rightVisible: boolean;
  footerVisible: boolean;
}

interface AppShellState {
  visibility: Record<ShellVisibilityScope, RegionVisibilityState>;
  density: "compact" | "comfortable";
  setRegionVisible: (scope: ShellVisibilityScope, region: ShellRegion, visible: boolean) => void;
  toggleRegion: (scope: ShellVisibilityScope, region: ShellRegion) => void;
  setDensity: (density: "compact" | "comfortable") => void;
  resetScope: (scope: ShellVisibilityScope) => void;
}

const defaultVisibility: Record<ShellVisibilityScope, RegionVisibilityState> = {
  root: { leftVisible: true, rightVisible: true, footerVisible: true },
  workspace: { leftVisible: true, rightVisible: true, footerVisible: true },
};

function regionToKey(region: ShellRegion): keyof RegionVisibilityState {
  if (region === "left") return "leftVisible";
  if (region === "right") return "rightVisible";
  return "footerVisible";
}

/**
 * Client-only shell preference store.
 *
 * Threat / contract:
 *   - This store persists ONLY layout preferences (region visibility,
 *     density). It MUST NOT persist auth tokens, session ids, role
 *     decisions, or any authority-bearing data.
 *   - Server-side route guards (`requireSecureSession`) and API handlers
 *     remain the single source of truth for authorization. The persisted
 *     state can therefore be safely loaded from `localStorage` on first
 *     paint without expanding the trust surface.
 */
export const useAppShellStore = create<AppShellState>()(
  persist(
    (set) => ({
      visibility: defaultVisibility,
      density: "compact",

      setRegionVisible: (scope, region, visible) =>
        set((state) => {
          const key = regionToKey(region);
          return {
            visibility: {
              ...state.visibility,
              [scope]: {
                ...state.visibility[scope],
                [key]: visible,
              },
            },
          };
        }),

      toggleRegion: (scope, region) =>
        set((state) => {
          const key = regionToKey(region);
          return {
            visibility: {
              ...state.visibility,
              [scope]: {
                ...state.visibility[scope],
                [key]: !state.visibility[scope][key],
              },
            },
          };
        }),

      setDensity: (density) => set({ density }),

      resetScope: (scope) =>
        set((state) => ({
          visibility: {
            ...state.visibility,
            [scope]: defaultVisibility[scope],
          },
        })),
    }),
    {
      name: "enterprise-app-shell",
      storage: createJSONStorage(() =>
        typeof window === "undefined" ? (undefined as unknown as Storage) : window.localStorage,
      ),
      partialize: (state) => ({
        visibility: state.visibility,
        density: state.density,
      }),
    },
  ),
);
