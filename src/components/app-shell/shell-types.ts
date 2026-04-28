import type { ReactNode } from "react";

/** Variant indicates root vs nested shell wrapping behavior. */
export type ShellVariant = "root" | "nested";
/** Density mode controlled by the parent layout. */
export type ShellDensity = "comfortable" | "compact";
/** Sidebar mode controls how a region behaves on small screens. */
export type ShellSidebarMode = "static" | "drawer" | "hidden";
/** Footer mode controls whether a footer slot is rendered at all. */
export type ShellFooterMode = "visible" | "hidden";
/** Identifier for shell regions whose visibility can be toggled. */
export type ShellRegion = "left" | "right" | "footer";
/** Visibility scope distinguishes the root shell from nested workspaces. */
export type ShellVisibilityScope = "root" | "workspace";

export interface ShellSlotProps {
  children?: ReactNode;
  className?: string;
}

export interface ShellControlledVisibilityProps {
  leftVisible?: boolean;
  rightVisible?: boolean;
  footerVisible?: boolean;
}

export interface ShellGridContainerProps extends ShellControlledVisibilityProps {
  variant: ShellVariant;
  depth: number;
  header?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  mainClassName?: string;
  density?: ShellDensity;
  leftMode?: ShellSidebarMode;
  rightMode?: ShellSidebarMode;
  footerMode?: ShellFooterMode;
  ariaLabel?: string;
  mainId?: string;
}

export interface ShellContainerProps extends ShellControlledVisibilityProps {
  branding?: ReactNode;
  header?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  mainClassName?: string;
  ariaLabel?: string;
  mainId?: string;
}

export interface ApplicationShellProps extends ShellControlledVisibilityProps {
  header?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  mainClassName?: string;
  ariaLabel?: string;
  mainId?: string;
}

export type {
  EnterpriseApplicationMenuItem,
  NavigationMenuItem,
  NavigationMenuResponse,
} from "@/components/navigation/menu-types";
