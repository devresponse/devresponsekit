"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UserOrganization } from "@/lib/active-org.server";

export interface OrganizationSwitcherProps {
  /** Active organization id (the current `getUserAccessContext` org). */
  current: string;
  /** Organizations the user is an active member of. */
  organizations: UserOrganization[];
}

/**
 * OrganizationSwitcher
 *
 * Switches the caller's active organization for a multi-org account. The
 * selection is a cookie (set by `/api/preferences/active-org`, which
 * validates membership), so there is no URL change — we reload the current
 * page so the server re-resolves `getUserAccessContext` with the new active
 * org. The parent only mounts this when the user belongs to more than one org.
 */
export function OrganizationSwitcher({ current, organizations }: OrganizationSwitcherProps) {
  const t = useTranslations("common");
  const [isPending, startTransition] = useTransition();

  const handleChange = (next: string) => {
    if (next === current || !organizations.some((o) => o.id === next)) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/preferences/active-org", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: next }),
        });
        // F-68: a FULL reload, like the impersonation start/stop flows. The
        // old `router.refresh()` re-rendered only the server components, so
        // every client-fetched, org-scoped view kept the previous org: the
        // primary sidebar menu (fetched once in an effect), every admin
        // DataGrid's rows and its bulk selection. The sidebar kept offering
        // the old org's admin entries (each a 404), and a grid kept listing
        // the old org's rows under the new org's header.
        if (res.ok) window.location.reload();
      } catch {
        // F-68: a network failure is a failed switch, handled like a non-2xx
        // (the UI stays on the current org). Thrown out of the transition, it
        // reached the error boundary above the secure layout and replaced the
        // whole app with an error page.
      }
    });
  };

  return (
    <Select value={current} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger aria-label={t("organization")} className="h-8 w-[12rem] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {organizations.map((org) => (
          <SelectItem key={org.id} value={org.id}>
            {org.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
