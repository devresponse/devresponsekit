"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * "\* indicates a required field" legend. Pair it with any form that marks
 * required fields with an asterisk so the marker is explained once, in the
 * caller's locale. The visual asterisk is decorative (`aria-hidden`); the
 * required state itself is announced via each control's `aria-required`.
 */
export function RequiredLegend({ className }: { className?: string }) {
  const t = useTranslations("validation");
  return (
    <p className={cn("text-muted-foreground text-xs", className)}>
      <span aria-hidden="true" className="text-destructive">
        *
      </span>{" "}
      {t("requiredLegend")}
    </p>
  );
}
