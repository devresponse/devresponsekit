import { ApplicationSwitcherSheet } from "@/components/app-shell/application-switcher-sheet";
import { CompactDensityWrapper } from "@/components/app-shell/compact-density-wrapper";
import { ShellContainer } from "@/components/app-shell/shell-container";
import { ShellSkipLinks } from "@/components/app-shell/shell-skip-links";
import { TopShellBar } from "@/components/app-shell/top-shell-bar";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { DialogManagerProvider } from "@/components/ui/dialog-manager";
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

  return (
    <CompactDensityWrapper density="compact" className="h-screen">
      <ShellSkipLinks />
      <ShellContainer
        ariaLabel="DevResponse Enterprise Application"
        branding={
          <TopShellBar>
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
    </CompactDensityWrapper>
  );
}
