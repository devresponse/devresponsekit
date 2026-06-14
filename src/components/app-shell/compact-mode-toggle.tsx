"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useAppShellStore } from "@/stores/app-shell-store";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * CompactModeToggle
 *
 * Switches the persisted shell density between `compact` and `comfortable`.
 * Used in the secure shell so users can opt out of the default compact
 * density (§16.5). Reads/writes only the Zustand layout-preference store —
 * no auth, role, or session data flows through this component.
 */
export function CompactModeToggle({ className }: { className?: string }) {
  const t = useTranslations("common");
  const density = useAppShellStore((s) => s.density);
  const setDensity = useAppShellStore((s) => s.setDensity);
  const hydrated = useHydrated();
  // Until hydrated, render the SSR default ("compact") so aria-pressed
  // matches the server markup; the action always uses the live value.
  const isCompact = hydrated ? density === "compact" : true;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={isCompact}
      aria-label={t("compactMode")}
      className={className}
      onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
    >
      {t("compactMode")}
    </Button>
  );
}
