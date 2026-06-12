import "@/app/globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme/theme-provider";

/**
 * RootLayout
 *
 * Minimal HTML scaffold per §28.1. Fonts, metadata, and the theme
 * provider only — no secure-menu fetches, no user-specific data, no
 * providers that depend on locale. Locale providers live one level
 * down in `[locale]/layout.tsx` so unknown locales 404 cleanly.
 *
 * The theme provider is locale-independent by design: it toggles the
 * `dark` class on <html> and every token in globals.css follows.
 */
export const metadata: Metadata = {
  title: {
    default: "DevResponse Enterprise Platform",
    template: "%s · DevResponse",
  },
  description: "Enterprise application shell.",
  icons: {
    icon: "/favicon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
