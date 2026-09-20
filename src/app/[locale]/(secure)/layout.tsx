import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { ApplicationSwitcherSheet } from "@/components/app-shell/application-switcher-sheet";
import { CompactDensityWrapper } from "@/components/app-shell/compact-density-wrapper";
import { ShellContainer } from "@/components/app-shell/shell-container";
import { ShellSkipLinks } from "@/components/app-shell/shell-skip-links";
import { TopShellBar } from "@/components/app-shell/top-shell-bar";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { BrandLogo } from "@/components/brand/brand-logo";
import { getBrand } from "@/config/brand";
import { DialogManagerProvider } from "@/components/ui/dialog-manager";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/flexsidebar";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { OrganizationSwitcher } from "@/components/app-shell/organization-switcher";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { getImpersonatorId, requireSecureSession } from "@/lib/auth-guard";
import { listUserActiveOrganizations } from "@/lib/active-org.server";
import { listImpersonationReachableOrgIds } from "@/lib/impersonation-reach.server";
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
  const { session, access } = await requireSecureSession(
    safeLocale,
    `/${safeLocale}/app/dashboard`,
  );

  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  // Multi-org accounts get an organization switcher in the brand bar; the
  // active org itself is resolved from the `active_org` cookie inside
  // `getUserAccessContext`, so `access.organizationId` is already the active one.
  let organizations = access.appUserId ? await listUserActiveOrganizations(access.appUserId) : [];

  // IMP-1: while impersonating, this list is the TARGET's tenancy, not the
  // admin's — so unfiltered it names organizations the admin has no business
  // knowing about, and offers switch controls that the P0-1 refusal would
  // reject anyway. Show only what the borrowed session can actually resolve:
  // the same confinement `getUserAccessContext` applies, resolved through the
  // SAME helper (IMP-2) so the switcher cannot drift from the boundary — a
  // `null` reach means unconfined (a superadmin), and filtering that to the
  // superadmin's own memberships would hide the very tenant they are
  // supporting in. This is presentation hardening, not the boundary — the
  // boundary is the confinement itself. Memoized per request, so this shares
  // its round trips with the resolver's.
  const impersonatorId = getImpersonatorId(session);
  if (impersonatorId) {
    const reachableIds = await listImpersonationReachableOrgIds(impersonatorId);
    if (reachableIds !== null) {
      const reachable = new Set(reachableIds);
      organizations = organizations.filter((org) => reachable.has(org.id));
    }
  }

  // Localized landmark labels (P2-15). This layout is a Server Component, so it
  // resolves the strings and passes them to the (Server) shell components,
  // which cannot call useTranslations themselves.
  const tRegions = await getTranslations("shell.regions");
  const brand = getBrand();

  return (
    <CompactDensityWrapper density="compact" className="h-screen">
      <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-full">
        <ShellSkipLinks />
        <ShellContainer
          className="w-full"
          ariaLabel={brand.name}
          branding={
            <TopShellBar ariaLabel={tRegions("banner")}>
              <SidebarTrigger className="-ml-1" srLabel={tRegions("toggleSidebar")} />
              <BrandLogo compact className="text-sm font-semibold" />
              <div className="ml-auto flex items-center gap-2">
                <ApplicationSwitcherSheet locale={safeLocale} />
                {organizations.length > 1 && access.organizationId ? (
                  <OrganizationSwitcher
                    current={access.organizationId}
                    organizations={organizations}
                  />
                ) : null}
                <ThemeToggle />
                <LocaleSwitcher current={safeLocale} persistAuthenticated />
                <SignOutButton locale={safeLocale} />
              </div>
            </TopShellBar>
          }
          leftAriaLabel={tRegions("sidebar")}
          // The sidebar only asks "does this caller have ANY permission?" before
          // deciding whether to fetch the menu, so send the ANSWER, not the whole
          // permission array — it kept the caller's full grant list in the RSC
          // payload for no reader (review #213).
          left={
            <SecureSidebar locale={safeLocale} hasPermissions={access.permissions.length > 0} />
          }
        >
          <ImpersonationBanner />
          <DialogManagerProvider>{children}</DialogManagerProvider>
        </ShellContainer>
      </SidebarProvider>
    </CompactDensityWrapper>
  );
}
