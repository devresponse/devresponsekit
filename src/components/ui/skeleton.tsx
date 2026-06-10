import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Skeleton primitive used by API-driven menus and content areas to avoid
 * layout shift during loading. Heights match the resolved component to
 * keep the grid stable.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-shell-muted animate-pulse rounded-md", className)}
      aria-hidden="true"
      {...props}
    />
  );
}
