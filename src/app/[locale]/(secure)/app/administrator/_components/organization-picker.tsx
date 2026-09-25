"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminSearch } from "@/lib/admin/admin-list.client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ListLimitNotice } from "./list-limit-notice";

/**
 * Shared organization picker for Administrator "new" forms (ADR-0002).
 *
 * Rendered only for SUPERADMINs, who must target a specific organization
 * for an org-scoped entity:
 *   - a GROUP is always org-scoped     → `includeGlobal={false}` (a real
 *     selection is required);
 *   - a ROLE may be Global or org-scoped → `includeGlobal` offers "Global".
 *
 * An ORG ADMIN never sees this control — the server forces their own org.
 *
 * A Shadcn combobox (Popover + cmdk Command) that searches SERVER-SIDE by
 * name or slug (`useAdminSearch`, F-41). It used to load one page of 200 orgs
 * and filter that client-side, so on a platform with more orgs every later
 * slug answered "No results": a superadmin could not create a group there at
 * all (the group form requires an org), and a new role fell back to Global.
 * `value` is the org id, or `null` for the Global / unselected scope.
 */
interface OrgOption {
  id: string;
  slug: string;
  name: string;
}

export function OrganizationPicker({
  value,
  onChange,
  includeGlobal = false,
  disabled = false,
  id = "organization-picker",
}: {
  value: string | null;
  onChange(next: string | null): void;
  includeGlobal?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations("administrator.organizationPicker");
  const search = useAdminSearch<OrgOption>("/api/administrator/organizations");
  const orgs = search.items;
  const [open, setOpen] = useState(false);
  // The chosen org, kept for the trigger label: a later search may no longer
  // return it (F-41: the results are one search's answer, not every org).
  const [picked, setPicked] = useState<OrgOption | null>(null);

  // A failed INITIAL load (nothing ever returned) makes the picker unusable.
  // A later search error keeps the prior results and says so in the list.
  if (search.error && orgs === null) {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{t("label")}</Label>
        <p className="text-destructive text-sm" role="alert">
          {t("loadError")}
        </p>
      </div>
    );
  }

  const selected =
    orgs?.find((o) => o.id === value) ?? (picked !== null && picked.id === value ? picked : null);
  const triggerLabel =
    orgs === null
      ? t("loading")
      : value === null
        ? includeGlobal
          ? t("global")
          : t("placeholder")
        : selected
          ? `${selected.name} (${selected.slug})`
          : t("placeholder");

  // The Global choice is local, not a server row: offer it while the search
  // is empty or matches its label, as cmdk's own filter used to.
  const q = search.query.trim().toLowerCase();
  const showGlobal = includeGlobal && (q === "" || t("global").toLowerCase().includes(q));

  const select = (next: OrgOption | null) => {
    setPicked(next);
    onChange(next?.id ?? null);
    setOpen(false);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("label")}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || orgs === null}
            className="w-full justify-between font-normal"
          >
            <span className={cn("truncate", value === null && "text-muted-foreground")}>
              {triggerLabel}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t("searchPlaceholder")}
              value={search.query}
              onValueChange={search.setQuery}
            />
            <CommandList>
              <CommandEmpty>{t("noResults")}</CommandEmpty>
              <CommandGroup>
                {showGlobal ? (
                  <CommandItem value="global" onSelect={() => select(null)}>
                    <Check
                      className={cn("mr-2 h-4 w-4", value === null ? "opacity-100" : "opacity-0")}
                    />
                    {t("global")}
                  </CommandItem>
                ) : null}
                {(orgs ?? []).map((o) => (
                  <CommandItem key={o.id} value={o.id} onSelect={() => select(o)}>
                    <Check
                      className={cn("mr-2 h-4 w-4", value === o.id ? "opacity-100" : "opacity-0")}
                    />
                    {o.name} ({o.slug})
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            {search.error ? (
              <p className="text-destructive px-2 py-1.5 text-xs" role="alert">
                {t("loadError")}
              </p>
            ) : null}
            <ListLimitNotice
              shown={orgs?.length ?? 0}
              total={search.total}
              kind="search"
              className="border-t px-2 py-1.5"
            />
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
