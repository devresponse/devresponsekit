import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * PermissionsCard
 *
 * Read-only display of the permission keys the signed-in user currently
 * holds in their active organization. Pure display — the page passes the
 * already-resolved `access.permissions` (expanded to the full set for
 * superusers by `getUserAccessContext`) and localized strings; this scopes
 * to no one but the caller.
 *
 * Built to be asserted against in tests: the list carries
 * `data-testid="account-permissions"` and each entry a `data-permission="<key>"`
 * attribute, so an E2E/component test can confirm a specific grant exists
 * without depending on layout or copy. Keys are sorted for a stable order.
 */
export interface PermissionsCardProps {
  permissions: string[];
  title: string;
  description: string;
  emptyLabel: string;
}

export function PermissionsCard({
  permissions,
  title,
  description,
  emptyLabel,
}: PermissionsCardProps) {
  const sorted = [...permissions].sort((a, b) => a.localeCompare(b));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-muted-foreground text-sm">{emptyLabel}</p>
        ) : (
          <ul data-testid="account-permissions" className="flex flex-wrap gap-1.5">
            {sorted.map((permission) => (
              <li key={permission}>
                <Badge
                  variant="outline"
                  className="font-mono text-xs font-normal"
                  data-permission={permission}
                >
                  {permission}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
