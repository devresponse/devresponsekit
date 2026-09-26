import { useTranslations } from "next-intl";
import { Badge, type BadgeProps } from "@/components/ui/badge";

/**
 * Shared status renderer used in every list view (admin grids, detail
 * pages, side panels). Centralising the value→variant mapping keeps
 * status colouring consistent across resources (users, apps,
 * organizations, memberships, etc.) and gives us one place to tweak.
 *
 * It also translates the status (F-116): `common.status.<value>`. Nine of its
 * thirteen call sites passed no `label`, so the Users, Memberships,
 * Organizations, Enterprise apps and Invitations grids showed the raw enum
 * (`pending_approval`) in every locale, next to a Status filter that read
 * "Pending approval" (the overview's Recent registrations did the same in a
 * plain Badge and now uses this). Not a client component: `useTranslations`
 * works in the server pages that render it too, since it is not async.
 */

type Variant = NonNullable<BadgeProps["variant"]>;

const VARIANT_BY_STATUS: Record<string, Variant> = {
  // Healthy / live
  active: "default",
  available: "default",
  approved: "default",
  accepted: "default",
  enabled: "default",

  // In-flight / awaiting action
  pending_approval: "secondary",
  pending: "secondary",
  invited: "secondary",
  draft: "secondary",

  // Terminal / blocking
  banned: "destructive",
  blocked: "destructive",
  revoked: "destructive",
  expired: "outline",
  suspended: "destructive",
  deactivated: "destructive",
  disabled: "destructive",
  soft_deleted: "destructive",
  archived: "destructive",
};

export interface StatusBadgeProps extends Omit<BadgeProps, "variant" | "children"> {
  status: string | null | undefined;
  /**
   * Optional label override; defaults to the translated status, or the raw
   * value when the catalog has no entry for it (a status added before its
   * translation).
   */
  label?: string;
}

export function StatusBadge({ status, label, className, ...rest }: StatusBadgeProps) {
  const t = useTranslations("common.status");
  const value = status ?? "";
  const variant: Variant = VARIANT_BY_STATUS[value] ?? "outline";
  return (
    <Badge variant={variant} className={className} {...rest}>
      {label ?? (value && t.has(value) ? t(value) : value)}
    </Badge>
  );
}
