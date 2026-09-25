/**
 * The ONE mobile/desktop breakpoint of the application shell (F-36).
 *
 * Three things decide how a sidebar is shown, and they must agree at every
 * width:
 *   - `useIsMobile` (JS) picks the branch: the in-flow rail or the Sheet
 *     drawer that `SidebarTrigger` opens;
 *   - `src/styles/app-shell.css` hides `.sh-left` / `.sh-right` below the
 *     breakpoint and pins the icon-collapsed column above it;
 *   - Tailwind's `md:` variant shows the rail itself (`hidden md:block` in
 *     `FlexSidebar` / `Sidebar`).
 *
 * They used to be written three ways: `(max-width: 767px)` in JS,
 * `(max-width: 768px)` / `(min-width: 769px)` in the CSS, and `48rem` in
 * Tailwind. At exactly 768px (iPad portrait, or a 1536px laptop at 200%
 * zoom) the CSS hid the rail while JS stayed on the desktop branch, so the
 * trigger collapsed a rail nobody could see and primary navigation was
 * unreachable. Any fractional width between 767 and 768 failed the same way.
 * And because the pixel queries ignore the user's default font size while
 * `48rem` follows it, a browser set to a larger font (20px makes `md`
 * 960px) lost the navigation across the whole 768–959px band.
 *
 * So both queries are written once, here, in Tailwind's own terms:
 *   - the same `48rem` as `--breakpoint-md`, so they track the font size
 *     exactly as `md:` does;
 *   - range syntax, the exact form Tailwind v4 compiles `md:` / `max-md:`
 *     to. `<` and `>=` split the axis with no gap and no overlap at ANY
 *     width, fractional ones included; a `max-width: 767.98px` style pair
 *     cannot. Every browser Tailwind v4 supports (Safari 16.4, Chrome 111,
 *     Firefox 128) parses it, in CSS and in `matchMedia` alike. Where Next's
 *     CSS pipeline lowers it for older targets, Lightning CSS writes the
 *     exact equivalents `(min-width: 48rem)` / `not (min-width: 48rem)`.
 *
 * CSS cannot import this module, so `app-shell.css` spells the same strings
 * and `tests/unit/breakpoints.test.ts` fails if any stylesheet, the compiled
 * Tailwind `md` variant or a source file drifts from them.
 */

/** Tailwind's `md` breakpoint (`--breakpoint-md` in tailwindcss/theme.css). */
export const MD_BREAKPOINT = "48rem";

/** Narrower than `md`: sidebars are drawers and the shell hides its side columns. */
export const MOBILE_MEDIA_QUERY = `(width < ${MD_BREAKPOINT})`;

/** `md` and wider: exactly the query Tailwind v4 compiles `md:` to. */
export const DESKTOP_MEDIA_QUERY = `(width >= ${MD_BREAKPOINT})`;
