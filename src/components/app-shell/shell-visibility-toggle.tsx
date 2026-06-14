"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useAppShellStore } from "@/stores/app-shell-store";
import { useHydrated } from "@/hooks/use-hydrated";
import type { ShellRegion, ShellVisibilityScope } from "./shell-types";

/**
 * ShellVisibilityToggle
 *
 * Renders a button that toggles a region's visibility within a scope.
 * Reads/writes the Zustand shell store; the resolved boolean MUST then be
 * passed to `ShellContainer` / `ApplicationShell` by the layout — shell
 * regions never own their own visibility state.
 *
 * Translations: button label keys are `shell.show{Region}` /
 * `shell.hide{Region}` so the accessible name is correct for screen
 * readers in every supported locale.
 */
export interface ShellVisibilityToggleProps {
  scope: ShellVisibilityScope;
  region: ShellRegion;
  className?: string;
}

const REGION_KEY: Record<ShellRegion, "leftVisible" | "rightVisible" | "footerVisible"> = {
  left: "leftVisible",
  right: "rightVisible",
  footer: "footerVisible",
};

const REGION_TRANSLATION_SUFFIX: Record<ShellRegion, "Left" | "Right" | "Footer"> = {
  left: "Left",
  right: "Right",
  footer: "Footer",
};

export function ShellVisibilityToggle({ scope, region, className }: ShellVisibilityToggleProps) {
  const t = useTranslations("shell");
  const visibility = useAppShellStore((s) => s.visibility[scope]);
  const toggle = useAppShellStore((s) => s.toggleRegion);
  const hydrated = useHydrated();

  const visibleKey = REGION_KEY[region];
  // Default to visible (the SSR default) until hydrated, so the label and
  // aria-pressed match the server markup.
  const isVisible = hydrated ? visibility[visibleKey] : true;
  const suffix = REGION_TRANSLATION_SUFFIX[region];
  const label = isVisible ? t(`hide${suffix}`) : t(`show${suffix}`);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={isVisible}
      aria-label={label}
      className={className}
      onClick={() => toggle(scope, region)}
    >
      {label}
    </Button>
  );
}
