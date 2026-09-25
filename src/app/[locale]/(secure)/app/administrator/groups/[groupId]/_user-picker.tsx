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
 * User picker for the group-detail "Add member" dialog.
 *
 * Users are unbounded, so this searches SERVER-SIDE through the shared
 * `useAdminSearch` (F-41; the organization, role and group pickers work the
 * same way): each query hits `GET /api/administrator/users?q=…` (org-scoped
 * server-side to the caller, ADR-0001), and a sequence guard drops stale
 * responses so out-of-order fetches can't clobber the latest. cmdk's own
 * filter is disabled (`shouldFilter={false}`) because the server already did
 * the matching.
 *
 * Eligibility (active member of the group's org) is enforced by the add
 * endpoint, not here; the caller surfaces the "not eligible" outcome.
 */
export interface UserOption {
  id: string;
  primary_email: string;
  display_name: string | null;
}

export function UserPicker({
  value,
  onChange,
  disabled = false,
  id = "user-picker",
}: {
  value: UserOption | null;
  onChange(next: UserOption | null): void;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations("administrator.userPicker");
  const search = useAdminSearch<UserOption>("/api/administrator/users");
  const users = search.items;
  const [open, setOpen] = useState(false);

  // A failed INITIAL load (nothing ever returned) makes the picker unusable —
  // surface it like the other pickers. A later search error keeps the prior
  // results on screen instead of blanking the control, and says so.
  if (search.error && users === null) {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{t("label")}</Label>
        <p className="text-destructive text-sm" role="alert">
          {t("loadError")}
        </p>
      </div>
    );
  }

  const triggerLabel =
    value !== null ? value.primary_email : users === null ? t("loading") : t("placeholder");

  const select = (next: UserOption | null) => {
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
            disabled={disabled}
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
                {(users ?? []).map((u) => (
                  <CommandItem
                    key={u.id}
                    value={u.id}
                    onSelect={() =>
                      select({
                        id: u.id,
                        primary_email: u.primary_email,
                        display_name: u.display_name,
                      })
                    }
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value?.id === u.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">
                      {u.primary_email}
                      {u.display_name ? (
                        <span className="text-muted-foreground"> · {u.display_name}</span>
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
              shown={users?.length ?? 0}
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
