/**
 * Theme configuration shared by the client {@link ThemeProvider} and the
 * server {@link ThemeScript}. Plain module (no `"use client"`) so both a server
 * and a client component can import it.
 */

/** localStorage key holding the user's theme preference. */
export const THEME_STORAGE_KEY = "theme";

/** A user-selectable theme preference. */
export type Theme = "light" | "dark" | "system";

/** A concrete applied theme (`system` resolved against the OS preference). */
export type ResolvedTheme = "light" | "dark";
