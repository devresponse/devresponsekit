"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { GridColumnDef } from "../_components/grid/data-grid";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../_components/grid/data-grid";

/**
 * Client-side groups grid (ADR-0002). Mirrors the roles grid: the `key`
 * cell links into the group-detail page, with an inline delete action gated
 * by `admin.groups.delete`.
 */
interface GroupRow {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description: string | null;
  role_count: number;
  member_count: number;
  created_at: string;
}

export function AdministratorGroupsGrid({
  locale,
  canDelete,
  headerActions,
}: {
  locale: string;
  canDelete: boolean;
  headerActions?: ReactNode;
}) {
  const t = useTranslations("administrator.groups");
  const tErr = useTranslations("administrator.errors");
  const intlLocale = useLocale();
  const dialogs = useDialogs();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }),
    [intlLocale],
  );

  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const onDelete = useCallback(
    async (id: string, key: string) => {
      const ok = await dialogs.confirm({
        title: t("deleteDialog.title"),
        description: t("deleteDialog.description") + "\n\n" + key,
        confirmLabel: t("deleteDialog.confirm"),
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/groups/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setRowError(tErr("generic"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, tErr, dialogs],
  );

  const columns = useMemo<GridColumnDef<GroupRow>[]>(
    () => [
      {
        id: "key",
        accessorKey: "key",
        header: () => t("columns.key"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/groups/${row.original.id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            <code className="text-xs">{row.original.key}</code>
          </LocaleLink>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: () => t("columns.name"),
        cell: ({ row }) => row.original.name,
      },
      {
        id: "role_count",
        accessorKey: "role_count",
        header: () => t("columns.roleCount"),
        cell: ({ row }) => row.original.role_count,
      },
      {
        id: "member_count",
        accessorKey: "member_count",
        header: () => t("columns.memberCount"),
        cell: ({ row }) => row.original.member_count,
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.createdAt"),
        cell: ({ row }) => {
          const d = new Date(row.original.created_at);
          return Number.isNaN(d.getTime()) ? row.original.created_at : dateFormatter.format(d);
        },
      },
      ...(canDelete
        ? [
            {
              id: "actions",
              enableSorting: false,
              header: () => "",
              cell: ({ row }: { row: { original: GroupRow } }) => (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onDelete(row.original.id, row.original.key)}
                  >
                    {t("deleteButton")}
                  </Button>
                </div>
              ),
            } as GridColumnDef<GroupRow>,
          ]
        : []),
    ],
    [t, locale, dateFormatter, canDelete, onDelete],
  );

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<GroupRow>
        key={reloadKey}
        name="administrator.groups"
        endpoint="/api/administrator/groups"
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "key", direction: "asc" }],
        }}
        searchable
        headerActions={headerActions}
      />
    </div>
  );
}
