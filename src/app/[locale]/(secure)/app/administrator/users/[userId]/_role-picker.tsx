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
 * Role picker for the user-detail "Assign role" dialog.
 *
 * Lists the ORG-SCOPED roles the caller can see (`GET /api/administrator/roles`,
 * org-boundary enforced server-side). Each option carries its own
 * `organization_id`, so the assign call derives the org context from the chosen
 * role — no separate org picker needed. Global roles (no org) are omitted: they
 * need an explicit org context to assign and are out of scope here.
 *
 * Mirrors `organization-picker.tsx` (Shadcn Popover + cmdk Command) so search
 * and a11y behave identically. `onChange` hands back the full option (or null).
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
  const [roles, setRoles] = useState<RoleOption[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/administrator/roles?pageSize=200", {
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const body = (await res.json()) as { items: RoleListItem[] };
        // Only org-scoped roles are directly assignable here.
        const assignable: RoleOption[] = body.items
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
        if (!cancelled) setRoles(assignable);
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
          <Command>
            <CommandInput placeholder={t("searchPlaceholder")} />
            <CommandList>
              <CommandEmpty>{t("noResults")}</CommandEmpty>
              <CommandGroup>
                {(roles ?? []).map((r) => (
                  <CommandItem
                    key={r.id}
                    value={`${r.name} ${r.key} ${r.organization_name ?? ""}`}
                    onSelect={() => select(r)}
                  >
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
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
