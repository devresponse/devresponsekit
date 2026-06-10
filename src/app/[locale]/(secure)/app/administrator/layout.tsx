import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ApplicationShell } from "@/components/app-shell/application-shell";
import { SidebarProvider } from "@/components/ui/flexsidebar";
import { ANY_ADMIN_PERMISSION, checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { AdministratorSidebar } from "./_components/administrator-sidebar";
import { AdministratorTopHeader } from "./_components/administrator-top-header";

export const dynamic = "force-dynamic";

/**
 * AdministratorLayout
 *
 * Workspace shell for the Administrator app (docs/admin-manager.md §2.1).
 *
 * Authorization:
 *   - Defense-in-depth on top of `(secure)/layout.tsx` — re-validates
 *     the caller holds *some* `admin.*` permission. If not, we render
 *     `notFound()` so the route is indistinguishable from a missing
 *     page (plan §6.2 layer 1).
 *   - Per-page guards (Phase 2+) call the more specific
 *     `requireAdminPermission(<exact perm>)` to enforce the read needed
 *     by that page.
 *
 * Shell rules:
 *   - Renders a nested `ApplicationShell` only — never a second
 *     `TopShellBar` (per `application-shell.tsx` contract).
 *   - The `AdministratorSidebar` receives the caller's permissions so
 *     it can hide groups the caller cannot use.
 *
 * Sidebar collapse: the layout mounts its OWN FlexSidebar
 * `SidebarProvider`, nested inside (and independent of) the root
 * shell's provider — separate cookie, and no keyboard shortcut so
 * Ctrl/Cmd+B keeps toggling only the root sidebar. The trigger lives
 * in `AdministratorTopHeader`.
 */
const SIDEBAR_COOKIE = "administrator_sidebar_state";

export default async function AdministratorLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer([...ANY_ADMIN_PERMISSION]);
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get(SIDEBAR_COOKIE)?.value !== "false";

  return (
    <SidebarProvider
      defaultOpen={sidebarDefaultOpen}
      cookieName={SIDEBAR_COOKIE}
      keyboardShortcut={null}
      className="h-full"
    >
      <ApplicationShell
        className="w-full"
        ariaLabel="Administrator"
        header={<AdministratorTopHeader locale={locale} permissions={guard.access.permissions} />}
        left={<AdministratorSidebar locale={locale} permissions={guard.access.permissions} />}
      >
        {children}
      </ApplicationShell>
    </SidebarProvider>
  );
}
