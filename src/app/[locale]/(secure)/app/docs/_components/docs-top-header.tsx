"use client";

import { useTranslations } from "next-intl";
import { SidebarTrigger } from "@/components/ui/flexsidebar";

/**
 * DocsTopHeader
 *
 * Header for the documentation viewer's nested `ApplicationShell`.
 * Minimal by design — the catalog lives in the left rail, so the header
 * only carries the sidebar toggle (its own nested provider) and the app
 * title. Mirrors `AccountTopHeader`.
 */
export function DocsTopHeader() {
  const t = useTranslations("docs");
  return (
    <div className="bg-background sticky top-0 z-30 overflow-x-auto">
      <div className="flex h-9 min-w-max items-stretch">
        <div className="flex shrink-0 items-center border-r px-1">
          <SidebarTrigger />
        </div>
        <div className="text-muted-foreground flex shrink-0 items-center px-3 text-[11px] font-semibold tracking-[0.16em] uppercase">
          {t("appTitle")}
        </div>
      </div>
    </div>
  );
}
