"use client";

/**
 * FlexSidebar — container-friendly variant of the shadcn sidebar.
 *
 * The stock shadcn `Sidebar` escapes its parent: the provider wrapper
 * forces `min-h-svh`, and the desktop panel is `position: fixed` over
 * the full viewport with a spacer div faking the layout gap. That
 * fights this project's Holy Grail shell, where the left region is a
 * normal grid cell below the top bar.
 *
 * This module deliberately contains NO duplicated machinery: the
 * provider/context/state machine, every sub-component, and the shared
 * static/mobile branches live in `./sidebar` (the single source) and
 * are re-exported here. FlexSidebar overrides exactly three things:
 *   - the provider wrapper fills its parent (`h-full min-h-0`) instead
 *     of the viewport;
 *   - the desktop panel is ONE in-flow flex column whose own width
 *     animates between `--sidebar-width` and `--sidebar-width-icon`
 *     (or 0 for offcanvas) — no fixed positioning, no viewport units,
 *     no spacer — so it can never stretch beyond the parent container
 *     or displace the surrounding shell layout;
 *   - the inset gains min-h-0/min-w-0 so it shrinks with the parent.
 *
 * All `group-data-*` / `peer-data-*` hooks are preserved, so every
 * sub-component (menu, tooltip-on-collapsed, rail) works unchanged.
 */
import * as React from "react";

import { cn } from "@/lib/utils";
import {
  SidebarInset as BaseSidebarInset,
  SidebarProvider as BaseSidebarProvider,
  SidebarMobileSheet,
  SidebarStatic,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * Provider for container-bounded sidebars. Same state machine as the
 * stock provider (cookie persistence, keyboard shortcut, mobile
 * sheet); only the wrapper sizing differs — it fills the parent
 * container exactly, never the viewport.
 */
const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof BaseSidebarProvider>
>(({ className, ...props }, ref) => (
  <BaseSidebarProvider ref={ref} className={cn("h-full min-h-0", className)} {...props} />
));
SidebarProvider.displayName = "SidebarProvider";

const FlexSidebar = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    side?: "left" | "right";
    variant?: "sidebar" | "floating" | "inset";
    collapsible?: "offcanvas" | "icon" | "none";
  }
>(
  (
    {
      side = "left",
      variant = "sidebar",
      collapsible = "offcanvas",
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const { isMobile, state } = useSidebar();

    if (collapsible === "none") {
      return (
        <SidebarStatic className={className} ref={ref} {...props}>
          {children}
        </SidebarStatic>
      );
    }

    if (isMobile) {
      return (
        <SidebarMobileSheet side={side} {...props}>
          {children}
        </SidebarMobileSheet>
      );
    }

    return (
      <div
        ref={ref}
        className="group peer text-sidebar-foreground hidden h-full md:block"
        data-state={state}
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-variant={variant}
        data-side={side}
      >
        {/*
          Flex variant: a single in-flow column that takes its height
          from the parent. No fixed positioning, no viewport units, no
          spacer div — collapsing animates this element's OWN width, so
          the sidebar occupies exactly the space the parent gives it and
          the surrounding layout never shifts beyond that box.
        */}
        <div
          className={cn(
            "relative flex h-full w-[--sidebar-width] flex-col transition-[width] duration-200 ease-linear",
            // Offcanvas collapses the column itself to zero width; clip
            // the content while it slides shut (the fixed original
            // slides off-screen instead).
            "group-data-[collapsible=offcanvas]:w-0 group-data-[collapsible=offcanvas]:overflow-hidden group-data-[collapsible=offcanvas]:border-0",
            // Adjust the padding for floating and inset variants.
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_theme(spacing.4)_+2px)]"
              : "group-data-[collapsible=icon]:w-[--sidebar-width-icon] group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className,
          )}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="bg-sidebar group-data-[variant=floating]:border-sidebar-border flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:shadow"
          >
            {children}
          </div>
        </div>
      </div>
    );
  },
);
FlexSidebar.displayName = "FlexSidebar";

/**
 * Inset for container-bounded layouts: min-h-0 / min-w-0 let it shrink
 * with the parent instead of forcing the flex row to grow past it.
 */
const SidebarInset = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof BaseSidebarInset>
>(({ className, ...props }, ref) => (
  <BaseSidebarInset ref={ref} className={cn("h-full min-h-0 min-w-0", className)} {...props} />
));
SidebarInset.displayName = "SidebarInset";

export { FlexSidebar, SidebarInset, SidebarProvider };

// Everything else is the shared implementation — re-exported so
// FlexSidebar consumers keep a single import path.
export {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
