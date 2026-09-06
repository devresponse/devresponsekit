"use client";

import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "@/components/theme/theme-provider";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

/**
 * ThemeToggle
 *
 * Switches between light and dark. Renders a stable placeholder until
 * mounted — `resolvedTheme` is unknowable during SSR, and rendering a
 * guess would flash the wrong icon (hydration mismatch). Mounted-ness
 * is derived via `useSyncExternalStore` (server snapshot `false`,
 * client snapshot `true`) instead of a setState-in-effect.
 *
 * The icon is decorative, so the button's accessible name is its
 * `aria-label` — which now comes from the message catalog rather than a
 * hardcoded English string, since the control ships in a fully localized
 * shell (review #106).
 */
const emptySubscribe = () => () => {};

export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("common");
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      aria-label={isDark ? t("switchToLightTheme") : t("switchToDarkTheme")}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}
