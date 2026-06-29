"use client";

import { useEffect, useRef, useState } from "react";
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
 * User picker for the group-detail "Add member" dialog.
 *
 * Unlike the role/group/org pickers (which fetch a bounded catalog once and
 * filter client-side), users are unbounded — so this searches SERVER-SIDE:
 * each query hits `GET /api/administrator/users?q=…` (org-scoped server-side
 * to the caller, ADR-0001), and a sequence guard drops stale responses so
 * out-of-order fetches can't clobber the latest. cmdk's own filter is disabled
 * (`shouldFilter={false}`) because the server already did the matching.
 *
 * Eligibility (active member of the group's org) is enforced by the add
 * endpoint, not here; the caller surfaces the "not eligible" outcome.
 */
export interface UserOption {
  id: string;
  primary_email: string;
  display_name: string | null;
}

interface UserListItem {
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
  const [users, setUsers] = useState<UserOption[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Monotonic request id: only the newest in-flight fetch may commit results.
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({ pageSize: "50" });
        if (query.trim()) qs.set("q", query.trim());
        const res = await fetch(`/api/administrator/users?${qs.toString()}`, {
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (!cancelled && mySeq === seq.current) setError(true);
          return;
        }
        const body = (await res.json()) as { items: UserListItem[] };
        if (!cancelled && mySeq === seq.current) {
          setError(false);
          setUsers(
            body.items.map((u) => ({
              id: u.id,
              primary_email: u.primary_email,
              display_name: u.display_name,
            })),
          );
        }
      } catch {
        if (!cancelled && mySeq === seq.current) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  // A failed INITIAL load (nothing ever returned) makes the picker unusable —
  // surface it like the other pickers. A later search error keeps the prior
  // results on screen instead of blanking the control.
  if (error && users === null) {
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
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>{t("noResults")}</CommandEmpty>
              <CommandGroup>
                {(users ?? []).map((u) => (
                  <CommandItem key={u.id} value={u.id} onSelect={() => select(u)}>
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
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
