"use client";

import { useTranslations } from "next-intl";

/**
 * Suspense fallback for the administrator section (P2-14). The admin pages
 * run server-side permission checks before streaming their (heavy) grids, so
 * this gives immediate, localized feedback on navigation instead of a blank
 * frame. Reuses the existing `common.loading` message. Client Component so the
 * label resolves against NextIntlClientProvider during the streamed shell.
 */
export default function AdministratorLoading() {
  const t = useTranslations("common");
  return (
    <div
      className="flex min-h-[40vh] items-center justify-center p-6"
      role="status"
      aria-live="polite"
    >
      <span className="text-muted-foreground text-sm">{t("loading")}</span>
    </div>
  );
}
