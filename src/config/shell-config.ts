import { SHELL_FOOTER_HEIGHT_PX, SHELL_LEFT_WIDTH_PX, SHELL_RIGHT_WIDTH_PX, SHELL_TOP_BAR_HEIGHT_PX } from "@/components/app-shell/shell-constants";

/**
 * Shell layout configuration.
 *
 * Centralises CSS-variable defaults and responsive breakpoints so the
 * shell grid and sidebar widths can be changed from one place.
 *
 * These values are consumed by `app-shell.css` via CSS custom property
 * overrides on the `:root` selector, and by TypeScript layout logic that
 * needs to match CSS behaviour.
 */

/** Shell CSS grid configuration. */
export const SHELL_CONFIG = {
  /** Top bar height used by the CSS grid `grid-template-rows` definition. */
  topBarHeight: SHELL_TOP_BAR_HEIGHT_PX,

  /** Left sidebar default width. */
  leftWidth: SHELL_LEFT_WIDTH_PX,

  /** Right inspector default width. */
  rightWidth: SHELL_RIGHT_WIDTH_PX,

  /** Footer bar height. */
  footerHeight: SHELL_FOOTER_HEIGHT_PX,

  /**
   * Breakpoint (in pixels) below which the left sidebar collapses to a
   * drawer (off-canvas) by default. Matches Tailwind's `md` breakpoint.
   */
  mobileBreakpointPx: 768,
} as const;

export type ShellConfig = typeof SHELL_CONFIG;
