"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Command, CommandDialog, CommandInput, CommandList, CommandEmpty,
 * CommandGroup, CommandItem, CommandShortcut, CommandSeparator
 *
 * Minimal command-palette stubs. The full cmdk integration is handled
 * by `cmdk` (already a dependency). These thin wrappers apply the
 * project's design-system classes.
 *
 * Used by: ApplicationSwitcherSheet, search dialogs.
 */
export function Command({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex h-full w-full flex-col overflow-hidden rounded-md bg-white text-sm", className)}
      {...props}
    />
  );
}

export function CommandInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn("flex w-full rounded-md bg-transparent px-3 py-2 outline-none placeholder:text-neutral-400", className)}
      {...props}
    />
  );
}

export function CommandList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("max-h-64 overflow-y-auto overflow-x-hidden", className)} {...props} />
  );
}

export function CommandEmpty({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("py-6 text-center text-sm text-neutral-400", className)} {...props} />;
}

export function CommandGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-hidden p-1", className)} {...props} />;
}

export function CommandItem({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-neutral-100", className)}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: React.HTMLAttributes<HTMLHRElement>) {
  return <hr className={cn("my-1 border-neutral-200", className)} {...props} />;
}

export function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("ml-auto text-xs tracking-widest text-neutral-400", className)} {...props} />
  );
}
