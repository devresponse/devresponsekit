"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Skeleton } from "@/components/ui/skeleton";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * "Roles using this permission" panel rendered inside the catalog Sheet
 * (docs/admin-manager.md §8.7).
 *
 * Reads the existing `/api/administrator/roles` endpoint with the
 * `permission` filter — there's no need for a dedicated reverse-lookup
 * endpoint, and reusing the list endpoint inherits its pagination,
 * sort, and permission-gating contract for free.
 */
interface RoleRow {
  id: string;
  key: string;
  name: string;
  organization_id: string | null;
}

export function RolesUsingPermissionPanel({ permissionKey }: { permissionKey: string }) {
  const t = useTranslations("administrator.permissions.rolesUsing");
  const tErr = useTranslations("administrator.errors");
  const locale = useLocale();

  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = new URL("/api/administrator/roles", window.location.origin);
        url.searchParams.set("filter.permission", permissionKey);
        url.searchParams.set("pageSize", "200");
        const res = await fetch(url.toString(), { credentials: "same-origin" });
        if (!res.ok) {
          if (!cancelled) setError(tErr("generic"));
          return;
        }
        const body = (await res.json()) as { items: RoleRow[] };
        if (!cancelled) setRows(body.items);
      } catch {
        if (!cancelled) setError(tErr("generic"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [permissionKey, tErr]);

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t("title")}</SheetTitle>
        <SheetDescription>
          <code className="text-xs">{permissionKey}</code>
        </SheetDescription>
      </SheetHeader>

      <div className="mt-4">
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : rows === null ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 p-3">
                <div className="space-y-1">
                  <p className="font-medium">{r.name}</p>
                  <code className="text-muted-foreground text-xs">{r.key}</code>
                </div>
                <LocaleLink
                  locale={locale}
                  href={`/app/administrator/roles/${r.id}`}
                  className="text-primary text-sm underline-offset-4 hover:underline"
                >
                  {t("viewRole")}
                </LocaleLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
