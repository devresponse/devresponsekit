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
import { ListLimitNotice } from "../../_components/list-limit-notice";

/**
 * Role picker for the user-detail "Assign role" dialog.
 *
 * Lists the ORG-SCOPED roles the caller can see (`GET /api/administrator/roles`,
 * org-boundary enforced server-side). Each option carries its own
 * `organization_id`, so the assign call derives the org context from the chosen
 * role — no separate org picker needed. Global roles (no org) are omitted: they
 * need an explicit org context to assign and are out of scope here.
 *
 * Searches SERVER-SIDE (`useAdminSearch`, F-41) by role key, role name or the
 * owning org's name, asking only for org-scoped roles (`filter[scope]=org`).
 * It used to load one page of 200 roles across every org, sorted by key, and
 * filter that client-side: with each org holding `admin` and `member`, keys
 * such as `support` never loaded and could not be assigned. The client-side
 * global-role filter below stays as defense in depth.
 */
export interface RoleOption {
  id: string;
  organization_id: string;
  organization_name: string | null;
  key: string;
  name: string;
}

interface RoleListItem {
  id: string;
  organization_id: string | null;
  organization_name: string | null;
  key: string;
  name: string;
}

export function RolePicker({
  value,
  onChange,
  disabled = false,
  id = "role-picker",
}: {
  value: RoleOption | null;
  onChange(next: RoleOption | null): void;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations("administrator.rolePicker");
  const search = useAdminSearch<RoleListItem>("/api/administrator/roles?filter[scope]=org");
  const [open, setOpen] = useState(false);

  if (search.error && search.items === null) {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{t("label")}</Label>
        <p className="text-destructive text-sm" role="alert">
          {t("loadError")}
        </p>
      </div>
    );
  }

  // Only org-scoped roles are directly assignable here.
  const roles: RoleOption[] | null =
    search.items === null
      ? null
      : search.items
          .filter(
            (r): r is RoleListItem & { organization_id: string } => r.organization_id !== null,
          )
          .map((r) => ({
            id: r.id,
            organization_id: r.organization_id,
            organization_name: r.organization_name,
            key: r.key,
            name: r.name,
          }));

  const triggerLabel =
    roles === null
      ? t("loading")
      : value === null
        ? t("placeholder")
        : value.organization_name
          ? `${value.name} · ${value.organization_name}`
          : value.name;

  const select = (next: RoleOption | null) => {
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
            disabled={disabled || roles === null}
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
                {(roles ?? []).map((r) => (
                  <CommandItem key={r.id} value={r.id} onSelect={() => select(r)}>
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value?.id === r.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">
                      {r.name}
                      {r.organization_name ? (
                        <span className="text-muted-foreground"> · {r.organization_name}</span>
                      ) : null}
                    </span>
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
              shown={search.items?.length ?? 0}
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
