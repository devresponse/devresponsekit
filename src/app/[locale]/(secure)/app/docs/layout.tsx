import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ApplicationShell } from "@/components/app-shell/application-shell";
import { SidebarProvider } from "@/components/ui/flexsidebar";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { getVisibleGroupedCatalog } from "@/lib/docs/catalog.server";
import { DocsSidebar } from "@/components/docs-viewer/docs-sidebar";
import { DocsTopHeader } from "@/components/docs-viewer/docs-top-header";

export const dynamic = "force-dynamic";

/**
 * DocsLayout
 *
 * Workspace shell for the documentation viewer. USER-LEVEL like the
 * Account app: it gates only on `requireSecureSession` (active user +
 * active membership) which the `(secure)` layout already guarantees —
 * there is NO `admin.*` check. The caller's permission set is used solely
 * to filter the catalog (per-doc `visibility` / `requires`).
 *
 * Renders a nested `ApplicationShell` (sidebar-first) with its OWN
 * FlexSidebar provider (separate cookie, no keyboard shortcut so
 * Ctrl/Cmd+B keeps toggling the root sidebar). The catalog tree is built
 * server-side and handed to the sidebar as plain data.
 */
const SIDEBAR_COOKIE = "docs_sidebar_state";

export default async function DocsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { access } = await requireSecureSession(locale, `/${locale}/app/docs`);

  const groups = await getVisibleGroupedCatalog(access.permissions);

  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get(SIDEBAR_COOKIE)?.value !== "false";
  // Localized landmark names (review #106) for the nested shell regions.
  const tRegions = await getTranslations({ locale, namespace: "shell.regions" });

  return (
    <SidebarProvider
      defaultOpen={sidebarDefaultOpen}
      cookieName={SIDEBAR_COOKIE}
      keyboardShortcut={null}
      className="h-full"
    >
      <ApplicationShell
        layout="sidebar-first"
        className="w-full"
        ariaLabel={tRegions("documentationShell")}
        leftAriaLabel={tRegions("documentationNavigation")}
        header={<DocsTopHeader />}
        left={<DocsSidebar locale={locale} groups={groups} />}
      >
        {children}
      </ApplicationShell>
    </SidebarProvider>
  );
}
