"use client";

import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useAppShellStore } from "@/stores/app-shell-store";
import { useHydrated } from "@/hooks/use-hydrated";
import type { ShellVisibilityScope } from "./shell-types";

export interface MobileSidebarTriggerProps {
  /**
   * Visibility scope to operate on. Use `"root"` for the application
   * shell sidebar and `"workspace"` for a nested `ApplicationShell`.
   */
  scope?: ShellVisibilityScope;
  className?: string;
}

/**
 * MobileSidebarTrigger
 *
 * Client Component. Mobile-only affordance that toggles the left
 * sidebar's visibility in the shell preference store. On `md` and up
 * the trigger is hidden via the `md:hidden` utility because the static
 * sidebar is always visible there per spec §17.4 (sidebars are
 * drawer-mode by default on secure mobile layouts).
 *
 * Accessibility: exposes `aria-controls="navigation"` (the `id` set by
 * `ShellLeft`) and `aria-expanded` reflecting the current store value
 * so the relationship between the trigger and the sidebar is clear to
 * assistive technologies.
 *
 * Authority: this only flips a layout preference; route guards and
 * API authorization remain server-side per the shell store contract.
 */
export function MobileSidebarTrigger({ scope = "root", className }: MobileSidebarTriggerProps) {
  const t = useTranslations("common");
  const storeVisible = useAppShellStore((s) => s.visibility[scope].leftVisible);
  const toggle = useAppShellStore((s) => s.toggleRegion);
  const hydrated = useHydrated();
  // SSR default is visible; defer the persisted value until hydrated so
  // aria-expanded/label match the server markup (P2-2).
  const isVisible = hydrated ? storeVisible : true;

  const label = isVisible ? t("closeMenu") : t("openMenu");

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      aria-controls="navigation"
      aria-expanded={isVisible}
      onClick={() => toggle(scope, "left")}
      className={`md:hidden ${className ?? ""}`.trim()}
      data-mobile-sidebar-trigger=""
    >
      <Menu className="h-4 w-4" aria-hidden="true" />
    </Button>
  );
}
