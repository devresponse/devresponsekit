"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { THEME_STORAGE_KEY, type ResolvedTheme, type Theme } from "./theme-config";

export interface ThemeContextValue {
  /** The user's selected preference: `light`, `dark`, or `system`. */
  theme: Theme;
  /** Persist + apply a new preference. */
  setTheme: (theme: Theme) => void;
  /** The concrete theme in effect (`system` resolved against the OS preference). */
  resolvedTheme: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const SYSTEM_QUERY = "(prefers-color-scheme: dark)";
/** Same-tab notification (the `storage` event only fires in OTHER tabs). */
const THEME_CHANGE_EVENT = "devresponsekit:themechange";

// --- Theme preference, backed by localStorage (an external store) ---

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    /* localStorage unavailable (private mode, blocked storage) — fall through */
  }
  return "system";
}

function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  };
}

// --- OS dark preference, backed by matchMedia (an external store) ---

function subscribeSystem(onChange: () => void): () => void {
  const mq = window.matchMedia(SYSTEM_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function getSystemDark(): boolean {
  return window.matchMedia(SYSTEM_QUERY).matches;
}

/**
 * Apply the resolved theme to `<html>`, mirroring {@link ThemeScript}. Disables
 * CSS transitions for the swap so toggling doesn't animate every colour token
 * (parity with `next-themes`' `disableTransitionOnChange`); styles are inline,
 * which the CSP `style-src` permits.
 */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  const style = document.createElement("style");
  style.appendChild(document.createTextNode("*,*::before,*::after{transition:none!important}"));
  document.head.appendChild(style);

  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;

  // Force a reflow so the no-transition rule covers this change, then drop it.
  window.getComputedStyle(document.body);
  window.setTimeout(() => style.remove(), 1);
}

/**
 * ThemeProvider — in-house light/dark/system theme context.
 *
 * Replaces `next-themes`. The anti-flash script lives in {@link ThemeScript},
 * which emits it as opaque `innerHTML` so React never reconciles (and, on every
 * locale switch, re-creates) a `<script>` element — the path React 19 warns
 * about. This provider owns only the runtime context and renders no script.
 *
 * Both inputs are read via `useSyncExternalStore` (server snapshots:
 * preference `"system"`, OS `light`) so there is no `setState`-in-effect and no
 * hydration mismatch; the lone effect applies the result to `<html>`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeTheme, readStoredTheme, () => "system" as Theme);
  const systemDark = useSyncExternalStore(subscribeSystem, getSystemDark, () => false);
  const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  // Keep <html> in sync with the resolved theme (DOM side effect, not state).
  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* ignore unavailable storage */
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, resolvedTheme }),
    [theme, setTheme, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the active theme. Must be used within a {@link ThemeProvider}. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
