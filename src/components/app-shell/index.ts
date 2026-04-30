/**
 * Public barrel export for `src/components/app-shell`.
 *
 * Import shell primitives from this index to avoid brittle deep-path
 * imports that break when a component is renamed or moved:
 *
 * ```ts
 * import { ShellContainer, TopShellBar } from "@/components/app-shell";
 * ```
 *
 * Default exports (Next.js page/layout conventions) are NOT re-exported
 * here — only named exports from the named-component modules.
 */
export { ApplicationShell } from "./application-shell";
export { ApplicationSwitcherSheet } from "./application-switcher-sheet";
export { CompactModeToggle } from "./compact-mode-toggle";
export { MobileSidebarTrigger } from "./mobile-sidebar-trigger";
export { NavigationMenuSkeleton } from "./navigation-menu-skeleton";
export { ShellContainer } from "./shell-container";
export { ShellDepthProvider, useShellDepth } from "./shell-depth-provider";
export { ShellFooter } from "./shell-footer";
export { ShellGridContainer } from "./shell-grid-container";
export { ShellHeader } from "./shell-header";
export { ShellLeft } from "./shell-left";
export { ShellMain } from "./shell-main";
export { ShellRight } from "./shell-right";
export { ShellSkipLinks } from "./shell-skip-links";
export { ShellVisibilityToggle } from "./shell-visibility-toggle";
export { TopShellBar } from "./top-shell-bar";

export type {
  ApplicationShellProps,
  EnterpriseApplicationMenuItem,
  NavigationMenuItem,
  NavigationMenuResponse,
  ShellContainerProps,
  ShellControlledVisibilityProps,
  ShellGridContainerProps,
  ShellRegion,
  ShellVisibilityScope,
} from "./shell-types";
