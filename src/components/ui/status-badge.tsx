import { Badge, type BadgeProps } from "@/components/ui/badge";

/**
 * Shared status renderer used in every list view (admin grids, detail
 * pages, side panels). Centralising the value→variant mapping keeps
 * status colouring consistent across resources (users, apps,
 * organizations, memberships, etc.) and gives us one place to tweak.
 */

type Variant = NonNullable<BadgeProps["variant"]>;

const VARIANT_BY_STATUS: Record<string, Variant> = {
    // Healthy / live
    active: "default",
    available: "default",
    approved: "default",
    enabled: "default",

    // In-flight / awaiting action
    pending_approval: "secondary",
    pending: "secondary",
    invited: "secondary",
    draft: "secondary",

    // Terminal / blocking
    banned: "destructive",
    blocked: "destructive",
    suspended: "destructive",
    deactivated: "destructive",
    disabled: "destructive",
    soft_deleted: "destructive",
    archived: "destructive",
};

export interface StatusBadgeProps extends Omit<BadgeProps, "variant" | "children"> {
    status: string | null | undefined;
    /** Optional label override; defaults to the raw status value. */
    label?: string;
}

export function StatusBadge({ status, label, className, ...rest }: StatusBadgeProps) {
    const value = status ?? "";
    const variant: Variant = VARIANT_BY_STATUS[value] ?? "outline";
    return (
        <Badge variant={variant} className={className} {...rest}>
            {label ?? value}
        </Badge>
    );
}
