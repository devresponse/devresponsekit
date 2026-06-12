"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * ThemeProvider
 *
 * Thin client wrapper around `next-themes` so the server `RootLayout`
 * can mount it. Toggles the `dark` class on <html>; every design token
 * in `globals.css` swaps via the `.dark` block. `suppressHydrationWarning`
 * on <html> (already set) absorbs the class mismatch on first paint.
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
