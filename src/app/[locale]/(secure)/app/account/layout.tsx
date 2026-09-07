import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ApplicationShell } from "@/components/app-shell/application-shell";
import { SidebarProvider } from "@/components/ui/flexsidebar";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { AccountSidebar } from "./_components/account-sidebar";
import { AccountTopHeader } from "./_components/account-top-header";

export const dynamic = "force-dynamic";

/**
 * AccountLayout
 *
 * Workspace shell for the self-service Account app. Unlike the
 * Administrator app, this is USER-LEVEL: it gates only on
 * `requireSecureSession` (active user + active membership), which the
 * `(secure)` layout already guarantees — there is NO `admin.*` check and
 * the app never exposes admin-only data. The caller's permission set is
 * passed to the sidebar purely to filter the section view.
 *
 * Renders a nested `ApplicationShell` (sidebar-first) with its OWN
 * FlexSidebar provider (separate cookie, no keyboard shortcut so Ctrl/Cmd+B
 * keeps toggling the root sidebar). Mirrors the Administrator layout
 * structure so the two workspaces stay consistent.
 *
 * Landmarks (review #105/#106): the nested shell renders a labelled
 * `<section>` with depth-suffixed region ids, so the root shell keeps sole
 * ownership of `#main` / `#navigation` and the skip links stay unambiguous.
 * Both landmark names are localized rather than hardcoded English.
 */
const SIDEBAR_COOKIE = "account_sidebar_state";

export default async function AccountLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { access } = await requireSecureSession(locale, `/${locale}/app/account`);

  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get(SIDEBAR_COOKIE)?.value !== "false";
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
        ariaLabel={tRegions("accountShell")}
        leftAriaLabel={tRegions("accountNavigation")}
        header={<AccountTopHeader />}
        left={<AccountSidebar locale={locale} permissions={access.permissions} />}
      >
        {children}
      </ApplicationShell>
    </SidebarProvider>
  );
}
