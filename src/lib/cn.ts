import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Tailwind-aware class name combinator.
 *
 * Used by all shadcn-derived UI primitives. Resolves conflicting utility
 * classes by keeping the last one declared (Tailwind merge semantics).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
