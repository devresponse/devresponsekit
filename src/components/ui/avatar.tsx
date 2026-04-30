import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/cn";

/**
 * Avatar, AvatarImage, AvatarFallback
 *
 * shadcn/ui avatar primitive wrappers. Server-compatible; no client
 * APIs required. Used for user profile images in menus and lists.
 *
 * Accessibility: `AvatarImage` has an implicit `alt` from the parent
 * context; callers should always supply a meaningful `alt` prop.
 */
export function Avatar({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn("relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}

export function AvatarImage({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      className={cn("aspect-square h-full w-full", className)}
      {...props}
    />
  );
}

export function AvatarFallback({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-neutral-100 text-xs font-medium",
        className,
      )}
      {...props}
    />
  );
}
