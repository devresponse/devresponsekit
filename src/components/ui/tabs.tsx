"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "bg-muted text-muted-foreground inline-flex h-9 items-center justify-center rounded-lg p-1",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "ring-offset-background focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground inline-flex items-center justify-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "ring-offset-background focus-visible:ring-ring mt-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

/**
 * Controlled tabs whose chosen panels stay MOUNTED while inactive (F-158).
 *
 * Radix unmounts an inactive panel, and every unsaved edit inside it with it:
 * an admin who staged ten permission moves on a role and opened Members to see
 * who they would affect came back to an editor re-seeded from the page's
 * props, the moves silently gone; a half-typed Settings or Authentication form
 * went the same way. A panel that holds edits is therefore force-mounted and
 * only hidden. The `hidden` attribute (it overrides Radix's own, which a forced
 * mount sets to false) also takes it out of the accessibility tree and the
 * tab order. Read-only panels (grids that fetch when opened) keep Radix's
 * default and still reload each time they open.
 *
 *   const tabs = useKeptTabs("permissions");
 *   <Tabs {...tabs.root}> … <TabsContent value="settings" {...tabs.keep("settings")}>
 */
function useKeptTabs(defaultValue: string) {
  const [value, setValue] = React.useState(defaultValue);
  return {
    root: { value, onValueChange: setValue },
    keep: (panel: string) => ({ forceMount: true as const, hidden: value !== panel }),
  };
}

export { Tabs, TabsList, TabsTrigger, TabsContent, useKeptTabs };
