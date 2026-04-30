import type { ShellRegion, ShellVisibilityScope } from "./shell-types";

/**
 * Shell utility helpers.
 *
 * Pure functions used by Zustand store actions and layout components.
 * None of these helpers may import React or Next.js server modules so
 * they remain safe to use in both Server Components and client code.
 */

/**
 * Maps a `ShellRegion` to the corresponding visibility key in the store state.
 * Centralised here so the mapping is not duplicated across the store and
 * visibility-toggle components.
 */
export function regionToVisibilityKey(
  region: ShellRegion,
): "leftVisible" | "rightVisible" | "footerVisible" {
  if (region === "left") return "leftVisible";
  if (region === "right") return "rightVisible";
  return "footerVisible";
}

/**
 * Returns the ARIA label for a shell region sidebar toggle button.
 * The label changes based on the current visibility state so screen readers
 * announce the action that *will* happen on press.
 */
export function getRegionToggleLabel(
  scope: ShellVisibilityScope,
  region: ShellRegion,
  visible: boolean,
): string {
  const regionName = region === "left" ? "left sidebar" : region === "right" ? "right panel" : "footer";
  const scopePrefix = scope === "workspace" ? "workspace " : "";
  return visible ? `Hide ${scopePrefix}${regionName}` : `Show ${scopePrefix}${regionName}`;
}
