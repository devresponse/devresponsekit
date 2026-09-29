import type { ReactNode } from "react";

/** Variant indicates root vs nested shell wrapping behavior. */
export type ShellVariant = "root" | "nested";
/** Density mode controlled by the parent layout. */
export type ShellDensity = "comfortable" | "compact";
/** Sidebar mode controls how a region behaves on small screens. */
export type ShellSidebarMode = "static" | "drawer" | "hidden";
/** Footer mode controls whether a footer slot is rendered at all. */
export type ShellFooterMode = "visible" | "hidden";
/**
 * Region arrangement of the grid:
 *   - `header-first` (default): the header spans the full width and the
 *     left/right regions start below it (classic Holy Grail).
 *   - `sidebar-first`: the left region spans the full height and the
 *     header sits adjacent to it, over the content columns only.
 */
export type ShellLayout = "header-first" | "sidebar-first";

export interface ShellControlledVisibilityProps {
  leftVisible?: boolean;
  rightVisible?: boolean;
  footerVisible?: boolean;
}

export interface ShellGridContainerProps extends ShellControlledVisibilityProps {
  variant: ShellVariant;
  depth: number;
  layout?: ShellLayout;
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
  /** Accessible name for the main region landmark. */
  ariaLabel?: string;
  /** Landmark id for the main region. Defaults to `main` at root depth and
   *  `main-<depth>` for a nested shell so the two never collide (#105). */
  mainId?: string;
  /** Landmark id for the left region. Defaults to `navigation` at root depth
   *  and `navigation-<depth>` for a nested shell (#105). */
  leftId?: string;
  /** Localized accessible name for the left region landmark (#106). */
  leftAriaLabel?: string;
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
  /** Accessible name for the main region landmark. */
  ariaLabel?: string;
  /** Landmark id for the main region. Defaults to `main` at root depth and
   *  `main-<depth>` for a nested shell so the two never collide (#105). */
  mainId?: string;
  /** Landmark id for the left region. Defaults to `navigation` at root depth
   *  and `navigation-<depth>` for a nested shell (#105). */
  leftId?: string;
  /** Localized accessible name for the left region landmark (#106). */
  leftAriaLabel?: string;
}

export interface ApplicationShellProps extends ShellControlledVisibilityProps {
  layout?: ShellLayout;
  header?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  mainClassName?: string;
  /** Accessible name for the main region landmark. */
  ariaLabel?: string;
  /** Landmark id for the main region. Defaults to `main` at root depth and
   *  `main-<depth>` for a nested shell so the two never collide (#105). */
  mainId?: string;
  /** Landmark id for the left region. Defaults to `navigation` at root depth
   *  and `navigation-<depth>` for a nested shell (#105). */
  leftId?: string;
  /** Localized accessible name for the left region landmark (#106). */
  leftAriaLabel?: string;
}
