"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchAllPages, useAdminSearch } from "@/lib/admin/admin-list.client";
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
 * Group picker for the user-detail "Add to group" dialog.
 *
 * Lists the groups of the TARGET USER's organizations: the add endpoint
 * refuses a group in an org the user holds no membership in, so no other
 * group is offered. The orgs come from the user's memberships
 * (`GET …/users/[id]/memberships`, confined to the caller's scope), and each
 * one goes to `GET /api/administrator/groups` as a repeated
 * `filter[organization]` (org boundary enforced server-side). Groups the user
 * already belongs to (`excludeIds`) are listed but cannot be chosen, so the
 * list on screen is the server's answer as counted, never "No groups found"
 * over a "Showing N of M". The add call carries only the chosen `groupId`;
 * the server derives the org and enforces the membership and
 * privilege-escalation guards.
 *
 * Searches SERVER-SIDE (`useAdminSearch`, F-41) by group key, group name or
 * org name. It used to load one page of 200 groups across every org and
 * filter that client-side, so a group past the first 200 keys could not be
 * chosen. A server search over every org would not be enough either: with 60
 * orgs each holding an `engineering` group named "Engineering", no text
 * singles one out of the 50 an answer carries. Scoped to the user's orgs, it
 * lists theirs. When the user belongs to more than one org, each option names
 * its org, and typing an org's name narrows the list to that org's groups.
 */
export interface GroupOption {
  id: string;
  organization_id: string;
  key: string;
  name: string;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  organization_name: string | null;
}

/**
 * The most orgs sent as repeated `filter[organization]` values (about 6 KB of
 * query string). A user in more orgs is searched across the caller's whole
 * scope instead, where typing an org's name still narrows the list.
 */
const MAX_FILTERED_ORGS = 100;

/** The groups endpoint for the user's orgs; `null` when there are none. */
function groupsEndpoint(orgIds: string[]): string | null {
  if (orgIds.length === 0) return null;
  if (orgIds.length > MAX_FILTERED_ORGS) return "/api/administrator/groups";
  const qs = new URLSearchParams(orgIds.map((orgId) => ["filter[organization]", orgId]));
  return `/api/administrator/groups?${qs.toString()}`;
}

export function GroupPicker({
  userId,
  value,
  onChange,
  excludeIds = [],
  disabled = false,
  id = "group-picker",
}: {
  /** The user being added: the picker lists the groups of their orgs. */
  userId: string;
  value: GroupOption | null;
  onChange(next: GroupOption | null): void;
  /** Groups the user already belongs to: listed, but not selectable. */
  excludeIds?: string[];
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations("administrator.groupPicker");
  // The user's orgs (id → name) in the caller's scope; null while loading.
  const [orgs, setOrgs] = useState<ReadonlyMap<string, string> | null>(null);
  const [orgsError, setOrgsError] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAllPages<MembershipRow>(
      `/api/administrator/users/${encodeURIComponent(userId)}/memberships`,
    )
      .then(({ items }) => {
        if (cancelled) return;
        setOrgs(new Map(items.map((m) => [m.organization_id, m.organization_name ?? ""])));
      })
      .catch(() => {
        if (!cancelled) setOrgsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const search = useAdminSearch<GroupOption>(
    orgs === null ? null : groupsEndpoint([...orgs.keys()]),
  );
  // No org: nothing the user can join, and nothing to ask the server.
  const groups = orgs !== null && orgs.size === 0 ? [] : search.items;

  if (orgsError || (search.error && groups === null)) {
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
  const orgLabel = (organizationId: string): string | null =>
    orgs !== null && orgs.size > 1 ? orgs.get(organizationId) || null : null;

  const valueOrg = value === null ? null : orgLabel(value.organization_id);
  const triggerLabel =
    groups === null
      ? t("loading")
      : value === null
        ? t("placeholder")
        : valueOrg
          ? `${value.name} · ${valueOrg}`
          : value.name;

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
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t("searchPlaceholder")}
              value={search.query}
              onValueChange={search.setQuery}
            />
            <CommandList>
              <CommandEmpty>{t("noResults")}</CommandEmpty>
              <CommandGroup>
                {(groups ?? []).map((g) => {
                  const joined = exclude.has(g.id);
                  const org = orgLabel(g.organization_id);
                  return (
                    <CommandItem
                      key={g.id}
                      value={g.id}
                      disabled={joined}
                      onSelect={() =>
                        select({
                          id: g.id,
                          organization_id: g.organization_id,
                          key: g.key,
                          name: g.name,
                        })
                      }
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          value?.id === g.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">
                        {g.name}
                        <span className="text-muted-foreground"> · {g.key}</span>
                        {org ? <span className="text-muted-foreground"> · {org}</span> : null}
                        {joined ? (
                          <span className="text-muted-foreground"> · {t("alreadyMember")}</span>
                        ) : null}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
            {search.error ? (
              <p className="text-destructive px-2 py-1.5 text-xs" role="alert">
                {t("loadError")}
              </p>
            ) : null}
            <ListLimitNotice
              shown={groups?.length ?? 0}
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
