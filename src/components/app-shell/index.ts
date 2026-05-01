/**
 * App-shell barrel exports.
 *
 * Mirrors the export list required by spec §4.4 so consumers can write
 * `import { ShellContainer, ShellMain } from "@/components/app-shell"`
 * without reaching into individual files. Default exports are
 * intentionally NOT re-exported here — Next.js convention reserves
 * default exports for page/layout files only.
 */
export { ApplicationShell } from "./application-shell";
export { ApplicationSwitcherSheet } from "./application-switcher-sheet";
export { CompactDensityWrapper } from "./compact-density-wrapper";
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
