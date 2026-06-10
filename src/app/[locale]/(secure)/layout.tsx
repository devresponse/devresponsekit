import { cookies } from "next/headers";
import { ApplicationSwitcherSheet } from "@/components/app-shell/application-switcher-sheet";
import { CompactDensityWrapper } from "@/components/app-shell/compact-density-wrapper";
import { ShellContainer } from "@/components/app-shell/shell-container";
import { ShellSkipLinks } from "@/components/app-shell/shell-skip-links";
import { TopShellBar } from "@/components/app-shell/top-shell-bar";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { DialogManagerProvider } from "@/components/ui/dialog-manager";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/flexsidebar";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { SecureSidebar } from "./_components/secure-sidebar";
import type { ReactNode } from "react";

/** Secure tree depends on cookies/session — never prerender. */
export const dynamic = "force-dynamic";

/**
 * SecureLayout
 *
 * Server-side authorization boundary for `/[locale]/app/*`. Calls
 * `requireSecureSession` which short-circuits via redirect for
 * unauthenticated, pending, or blocked users — by the time the JSX
 * renders, the user is guaranteed `active` with an `active` membership.
 *
 * Compact density per §28.4. The secure shell is bounded to the viewport
 * so child regions own their own scrolling.
 *
 * Sidebar collapse: the layout mounts the FlexSidebar `SidebarProvider`
 * so the `SidebarTrigger` in the brand bar and the `SecureSidebar` in
 * the left region share one state. `defaultOpen` is read from the
 * `sidebar_state` cookie the provider writes, so the server-rendered
 * first paint matches the user's last choice (no flash on reload).
 * The grid's left column stays at its FIXED 16rem default; the
 * icon-collapsed 3rem width is pinned by the `.sh-grid:has(...)` rule
 * in app-shell.css — fixed track sizes in both states, so navigation
 * and active-item styling can never shift the column.
 */
export default async function SecureLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const safeLocale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { access } = await requireSecureSession(safeLocale, `/${safeLocale}/app/dashboard`);

  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <CompactDensityWrapper density="compact" className="h-screen">
      <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-full">
        <ShellSkipLinks />
        <ShellContainer
          className="w-full"
          ariaLabel="DevResponse Enterprise Application"
          branding={
            <TopShellBar>
              <SidebarTrigger className="-ml-1" />
              <span className="text-sm font-semibold">DevResponse</span>
              <div className="ml-auto flex items-center gap-2">
                <ApplicationSwitcherSheet locale={safeLocale} />
                <LocaleSwitcher current={safeLocale} persistAuthenticated />
                <SignOutButton locale={safeLocale} />
              </div>
            </TopShellBar>
          }
          left={<SecureSidebar locale={safeLocale} permissions={access.permissions} />}
        >
          <ImpersonationBanner />
          <DialogManagerProvider>{children}</DialogManagerProvider>
        </ShellContainer>
      </SidebarProvider>
    </CompactDensityWrapper>
  );
}
