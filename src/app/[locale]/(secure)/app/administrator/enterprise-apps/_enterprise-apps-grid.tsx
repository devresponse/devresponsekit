"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../_components/grid/data-grid";

/**
 * Client-side enterprise applications grid (docs/admin-manager.md §8.10,
 * Phase 6).
 *
 * Mirrors the structure of the organizations grid: the `id` cell is the
 * navigation affordance into the app-detail page, and per-row "Delete"
 * is an inline button gated by `canManage`. Per-row destructive actions
 * go through a confirm prompt and surface the canonical
 * `application_in_use` 409 inline so the user immediately sees why a
 * delete was refused.
 */
interface EnterpriseAppRow {
  id: string;
  label: string;
  description: string | null;
  origin: string;
  subdomain: string;
  sso_audience: string;
  status: string;
  sort_order: number;
  organization_id: string | null;
  organization_slug: string | null;
  created_at: string;
}

export function AdministratorEnterpriseAppsGrid({
  locale,
  canManage,
}: {
  locale: string;
  canManage: boolean;
}) {
  const t = useTranslations("administrator.enterpriseApps");
  const tErr = useTranslations("administrator.errors");
  const intlLocale = useLocale();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }),
    [intlLocale],
  );

  // Reload key — bumped after every successful delete so the grid
  // re-fetches without a full page reload.
  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const onDelete = useCallback(
    async (id: string, label: string) => {
      if (!window.confirm(t("deleteDialog.description") + "\n\n" + label)) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/enterprise-apps/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        if (body.error === "application_in_use") {
          setRowError(tErr("applicationInUse"));
        } else {
          setRowError(t("deleteError"));
        }
        return;
      }
      if (!res.ok) {
        setRowError(t("deleteError"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, tErr],
  );

  const columns = useMemo<ColumnDef<EnterpriseAppRow, unknown>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: () => t("columns.id"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/enterprise-apps/${encodeURIComponent(row.original.id)}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            <code className="text-xs">{row.original.id}</code>
          </LocaleLink>
        ),
      },
      {
        id: "label",
        accessorKey: "label",
        header: () => t("columns.label"),
        cell: ({ row }) => row.original.label,
      },
      {
        id: "subdomain",
        accessorKey: "subdomain",
        header: () => t("columns.subdomain"),
        cell: ({ row }) => <code className="text-xs">{row.original.subdomain}</code>,
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
      },
      {
        id: "organization_slug",
        accessorKey: "organization_slug",
        header: () => t("columns.organization"),
        cell: ({ row }) =>
          row.original.organization_slug ? (
            <code className="text-xs">{row.original.organization_slug}</code>
          ) : (
            <span className="text-neutral-500">{t("global")}</span>
          ),
      },
      {
        id: "sort_order",
        accessorKey: "sort_order",
        header: () => t("columns.sortOrder"),
        cell: ({ row }) => row.original.sort_order,
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.createdAt"),
        cell: ({ row }) => formatDate(row.original.created_at, dateFormatter),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              header: () => "",
              cell: ({ row }: { row: { original: EnterpriseAppRow } }) => (
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onDelete(row.original.id, row.original.label)}
                  >
                    {t("deleteButton")}
                  </Button>
                </div>
              ),
            } as ColumnDef<EnterpriseAppRow, unknown>,
          ]
        : []),
    ],
    [t, locale, dateFormatter, canManage, onDelete],
  );

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-sm text-red-600" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<EnterpriseAppRow>
        key={reloadKey}
        name="administrator.enterpriseApps"
        endpoint="/api/administrator/enterprise-apps"
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "sort_order", direction: "asc" }],
        }}
      />
    </div>
  );
}

function formatDate(value: string, formatter: Intl.DateTimeFormat): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatter.format(d);
}
