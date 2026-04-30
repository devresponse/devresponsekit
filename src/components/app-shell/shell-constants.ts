/**
 * Shell layout constants.
 *
 * Centralises magic numbers used by the CSS Grid shell so they can be
 * referenced from both TypeScript layout logic and CSS custom-property
 * values without duplication.
 */

/** Default width of the left sidebar in pixels. */
export const SHELL_LEFT_WIDTH_PX = 240;

/** Default width of the right inspector panel in pixels. */
export const SHELL_RIGHT_WIDTH_PX = 280;

/** Default height of the TopShellBar in pixels. */
export const SHELL_TOP_BAR_HEIGHT_PX = 48;

/** Default height of the shell footer bar in pixels. */
export const SHELL_FOOTER_HEIGHT_PX = 36;

/** Maximum nesting depth before the shell stops applying nested sizing. */
export const SHELL_MAX_DEPTH = 4;

/** `localStorage` key used by the app-shell Zustand store. */
export const SHELL_STORE_KEY = "enterprise-app-shell";
