"use client";

import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared loading placeholders for API-driven navigation regions.
 *
 * Heights approximate the resolved menu so the grid does not shift when
 * data arrives. `aria-busy` ensures screen readers announce the loading
 * state instead of an empty list, and the status region's accessible name
 * comes from the message catalog rather than hardcoded English — this is
 * announced text in a fully localized shell (review #106). Both call sites
 * (`SecureSidebar`, `ApplicationSwitcherSheet`) are already Client
 * Components, so the boundary costs nothing.
 */

export interface NavigationMenuSkeletonProps {
  rows?: number;
  compact?: boolean;
}

export function NavigationMenuSkeleton({ rows = 5, compact = false }: NavigationMenuSkeletonProps) {
  const t = useTranslations("shell.regions");
  return (
    <div
      className="space-y-2 p-2"
      aria-label={t("loadingNavigation")}
      aria-busy="true"
      role="status"
    >
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-md p-2">
          <Skeleton className="h-4 w-4 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/3" />
            {!compact ? <Skeleton className="h-3 w-1/2" /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AppSwitcherSkeleton() {
  return <NavigationMenuSkeleton rows={6} />;
}

export function SidebarMenuSkeleton() {
  return <NavigationMenuSkeleton rows={8} compact />;
}

export function NavbarMenuSkeleton() {
  return <NavigationMenuSkeleton rows={3} compact />;
}
