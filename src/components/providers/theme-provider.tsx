"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * ThemeProvider
 *
 * Client Component that wraps `next-themes` ThemeProvider with project
 * defaults. The `attribute="class"` setting applies the theme class to
 * `<html>` so Tailwind dark-mode variants work without a custom selector.
 *
 * `enableSystem` is false to maintain predictable enterprise light-mode
 * defaults; dark mode can be enabled per deployment via props.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
