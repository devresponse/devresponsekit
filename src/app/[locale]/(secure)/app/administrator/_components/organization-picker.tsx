"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
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
 * A Shadcn combobox (Popover + cmdk Command) backs it so the org list can be
 * filtered client-side by name or slug — far better than a flat <select>
 * once an installation has more than a handful of organizations. `value`
 * is the org id, or `null` for the Global / unselected scope.
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
  const [orgs, setOrgs] = useState<OrgOption[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/administrator/organizations?pageSize=200", {
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const body = (await res.json()) as { items: OrgOption[] };
        if (!cancelled) setOrgs(body.items);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{t("label")}</Label>
        <p className="text-destructive text-sm" role="alert">
          {t("loadError")}
        </p>
      </div>
    );
  }

  const selected = orgs?.find((o) => o.id === value) ?? null;
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

  const select = (next: string | null) => {
    onChange(next);
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
          <Command>
            <CommandInput placeholder={t("searchPlaceholder")} />
            <CommandList>
              <CommandEmpty>{t("noResults")}</CommandEmpty>
              <CommandGroup>
                {includeGlobal ? (
                  <CommandItem value="global" onSelect={() => select(null)}>
                    <Check
                      className={cn("mr-2 h-4 w-4", value === null ? "opacity-100" : "opacity-0")}
                    />
                    {t("global")}
                  </CommandItem>
                ) : null}
                {(orgs ?? []).map((o) => (
                  <CommandItem
                    key={o.id}
                    value={`${o.name} ${o.slug}`}
                    onSelect={() => select(o.id)}
                  >
                    <Check
                      className={cn("mr-2 h-4 w-4", value === o.id ? "opacity-100" : "opacity-0")}
                    />
                    {o.name} ({o.slug})
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
