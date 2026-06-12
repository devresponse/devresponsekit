"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Sheet primitive (Radix Dialog with side-anchored content).
 *
 * Used by the application switcher and mobile sidebar drawer. Includes
 * an accessible close button labelled with the i18n key passed by the
 * parent so the screen-reader announcement matches the active locale.
 */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/40",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: "left" | "right" | "top" | "bottom";
  closeLabel?: string;
}

const SHEET_SIDE_CLASSES: Record<NonNullable<SheetContentProps["side"]>, string> = {
  top: "inset-x-0 top-0 border-b w-full max-h-screen",
  bottom: "inset-x-0 bottom-0 border-t w-full max-h-screen",
  left: "inset-y-0 left-0 h-full w-3/4 sm:max-w-sm border-r",
  right: "inset-y-0 right-0 h-full w-3/4 sm:max-w-sm border-l",
};

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, closeLabel = "Close", ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "bg-background border-border fixed z-50 flex flex-col gap-4 p-6 shadow-lg transition ease-in-out",
        SHEET_SIDE_CLASSES[side],
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="ring-offset-background focus:ring-ring absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:outline-none disabled:pointer-events-none"
        aria-label={closeLabel}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = "SheetContent";

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-2 text-left", className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-foreground text-base font-semibold", className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-muted-foreground text-sm", className)}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription };
