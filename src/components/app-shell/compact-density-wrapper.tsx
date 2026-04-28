import type { ReactNode } from "react";

/**
 * CompactDensityWrapper
 *
 * Activates compact density styling on its subtree by setting
 * `data-density="compact"`. Secure shell layouts use this so all
 * shadcn primitives and `sh-*` controls render at the smaller height.
 *
 * Public/auth pages omit the wrapper and inherit comfortable density.
 */
export function CompactDensityWrapper({
  children,
  density = "compact",
  className,
}: {
  children: ReactNode;
  density?: "compact" | "comfortable";
  className?: string;
}) {
  return (
    <div data-density={density} className={className}>
      {children}
    </div>
  );
}
