"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import { LocaleLink } from "@/components/i18n/locale-link";
import { useAppFormatter } from "@/components/i18n/format-preferences";
import { DataGrid, type GridColumnDef } from "../_components/grid/data-grid";

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
  // The API's own error catalog: `errors.forbidden` says the ACTION is not
  // permitted, where `administrator.errors.forbidden` talks about viewing the
  // page, which is wrong on a page the admin is looking at.
  const tApiErr = useTranslations("errors");
  const dialogs = useDialogs();
  // F-37: the viewer's zone and date format.
  const format = useAppFormatter();

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
        // F-11: a 403 is the conferral guard refusing a group that confers
        // authority the admin lacks, not a transient fault — say so.
        setRowError(res.status === 403 ? tApiErr("forbidden") : tErr("generic"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, tErr, tApiErr, dialogs],
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
        cell: ({ row }) => format.date(row.original.created_at),
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
    [t, locale, format, canDelete, onDelete],
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
