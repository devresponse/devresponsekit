"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
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
 * validates membership), so there is no URL change — we just refresh so the
 * server re-resolves `getUserAccessContext` with the new active org. The
 * parent only mounts this when the user belongs to more than one org.
 */
export function OrganizationSwitcher({ current, organizations }: OrganizationSwitcherProps) {
  const t = useTranslations("common");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleChange = (next: string) => {
    if (next === current || !organizations.some((o) => o.id === next)) return;
    startTransition(async () => {
      const res = await fetch("/api/preferences/active-org", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: next }),
      });
      // Re-render server components so the new active org takes effect
      // everywhere (menus, pages, admin scope). Ignore failures — the UI
      // stays on the current org.
      if (res.ok) router.refresh();
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
