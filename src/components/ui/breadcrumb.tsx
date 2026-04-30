import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/cn";

/**
 * Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink,
 * BreadcrumbPage, BreadcrumbSeparator, BreadcrumbEllipsis
 *
 * shadcn/ui breadcrumb primitives. Server-compatible.
 *
 * Accessibility: `<nav aria-label="breadcrumb">` root wraps the list.
 * The current page item uses `aria-current="page"`.
 */
export function Breadcrumb({ ...props }: React.ComponentPropsWithoutRef<"nav">) {
  return <nav aria-label="breadcrumb" {...props} />;
}

export function BreadcrumbList({ className, ...props }: React.ComponentPropsWithoutRef<"ol">) {
  return (
    <ol
      className={cn("flex flex-wrap items-center gap-1 break-words text-sm text-neutral-500", className)}
      {...props}
    />
  );
}

export function BreadcrumbItem({ className, ...props }: React.ComponentPropsWithoutRef<"li">) {
  return <li className={cn("inline-flex items-center gap-1", className)} {...props} />;
}

export function BreadcrumbLink({
  asChild,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "a";
  return <Comp className={cn("transition-colors hover:text-neutral-900", className)} {...props} />;
}

export function BreadcrumbPage({ className, ...props }: React.ComponentPropsWithoutRef<"span">) {
  return (
    <span
      role="link"
      aria-current="page"
      aria-disabled
      className={cn("font-normal text-neutral-900", className)}
      {...props}
    />
  );
}

export function BreadcrumbSeparator({ className, ...props }: React.ComponentPropsWithoutRef<"li">) {
  return (
    <li role="presentation" aria-hidden className={cn("[&>svg]:h-3.5 [&>svg]:w-3.5", className)} {...props}>
      /
    </li>
  );
}

export function BreadcrumbEllipsis({ className, ...props }: React.ComponentPropsWithoutRef<"span">) {
  return (
    <span role="presentation" aria-hidden className={cn("flex h-9 w-9 items-center justify-center", className)} {...props}>
      …
    </span>
  );
}
