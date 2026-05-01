import "@/app/globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

/**
 * RootLayout
 *
 * Minimal HTML scaffold per §28.1. Fonts and metadata only — no
 * secure-menu fetches, no user-specific data, no providers that
 * depend on locale. Locale providers live one level down in
 * `[locale]/layout.tsx` so unknown locales 404 cleanly.
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
      <body>{children}</body>
    </html>
  );
}
