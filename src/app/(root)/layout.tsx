import { defaultLocale } from "@/config/i18n-config";
import type { ReactNode } from "react";

/**
 * Root layout for the bare `/` index only (a redirect to the default
 * locale — it never paints). Every real page lives under `[locale]/`,
 * whose own root layout owns the themed HTML shell with the correct
 * `lang`. Next.js still requires a valid layout chain here.
 */
export default function RootRedirectLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={defaultLocale}>
      <body>{children}</body>
    </html>
  );
}
