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
 * Group picker for the user-detail "Add to group" dialog.
 *
 * Lists the groups in the caller's org scope (`GET /api/administrator/groups`,
 * boundary enforced server-side), minus the ones the user already belongs to
 * (`excludeIds`). The add call carries only the chosen `groupId`; the server
 * derives the org and enforces the membership + privilege-escalation guards.
 *
 * Mirrors `_role-picker.tsx` (Shadcn Popover + cmdk Command).
 */
export interface GroupOption {
  id: string;
  organization_id: string;
  key: string;
  name: string;
}

export function GroupPicker({
  value,
  onChange,
  excludeIds = [],
  disabled = false,
  id = "group-picker",
}: {
  value: GroupOption | null;
  onChange(next: GroupOption | null): void;
  excludeIds?: string[];
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations("administrator.groupPicker");
  const [groups, setGroups] = useState<GroupOption[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/administrator/groups?pageSize=200", {
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const body = (await res.json()) as { items: GroupOption[] };
        if (!cancelled) {
          setGroups(
            body.items.map((g) => ({
              id: g.id,
              organization_id: g.organization_id,
              key: g.key,
              name: g.name,
            })),
          );
        }
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

  const exclude = new Set(excludeIds);
  const available = (groups ?? []).filter((g) => !exclude.has(g.id));

  const triggerLabel =
    groups === null ? t("loading") : value === null ? t("placeholder") : value.name;

  const select = (next: GroupOption | null) => {
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
            disabled={disabled || groups === null}
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
                {available.map((g) => (
                  <CommandItem key={g.id} value={`${g.name} ${g.key}`} onSelect={() => select(g)}>
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value?.id === g.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">
                      {g.name}
                      <span className="text-muted-foreground"> · {g.key}</span>
                    </span>
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
