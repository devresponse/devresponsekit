"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/cn";

/**
 * TooltipProvider, Tooltip, TooltipTrigger, TooltipContent
 *
 * shadcn/ui tooltip primitive wrappers. Client Component.
 * Used for icon buttons and truncated labels throughout the shell.
 *
 * Accessibility: Radix Tooltip associates the content with the trigger
 * via `aria-describedby` so screen readers announce the tooltip text.
 *
 * Usage:
 * ```tsx
 * <TooltipProvider>
 *   <Tooltip>
 *     <TooltipTrigger asChild><Button>…</Button></TooltipTrigger>
 *     <TooltipContent>Tooltip text</TooltipContent>
 *   </Tooltip>
 * </TooltipProvider>
 * ```
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden rounded-md border bg-white px-3 py-1.5 text-xs shadow-md",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
