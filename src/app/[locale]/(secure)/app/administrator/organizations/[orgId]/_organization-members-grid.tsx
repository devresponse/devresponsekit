"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../../_components/grid/data-grid";

/**
 * Members tab for the organization detail (docs/admin-manager.md §19).
 *
 * Reuses the shared `DataGrid` so URL-state, pagination and a11y
 * behave identically. Each row's user is a link into the user-detail
 * page so the operator can pivot from "members of org X" to the user's
 * full surface in one click.
 */
interface MemberRow {
  id: string;
  app_user_id: string;
  user_display_name: string | null;
  status: string;
  source_provider: string | null;
  created_at: string;
}

export function OrganizationMembersGrid({
  orgId,
  canUpdate,
}: {
  orgId: string;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.orgs.members");
  const locale = useLocale();
  const dialogs = useDialogs();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const onRemove = useCallback(
    async (membershipId: string, userName: string | null) => {
      const ok = await dialogs.confirm({
        title: t("removeConfirm"),
        description: userName ?? membershipId,
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/organizations/${orgId}/members`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membershipIds: [membershipId] }),
      });
      if (!res.ok) {
        setRowError(t("removeError"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, orgId, dialogs],
  );

  const columns = useMemo<ColumnDef<MemberRow, unknown>[]>(
    () => [
      {
        id: "user_display_name",
        accessorKey: "user_display_name",
        header: () => t("columns.user"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/users/${row.original.app_user_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.user_display_name ?? row.original.app_user_id}
          </LocaleLink>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "source_provider",
        accessorKey: "source_provider",
        header: () => t("columns.source"),
        cell: ({ row }) => row.original.source_provider ?? "—",
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.joinedAt"),
        cell: ({ row }) => {
          const d = new Date(row.original.created_at);
          return Number.isNaN(d.getTime())
            ? row.original.created_at
            : dateFormatter.format(d);
        },
      },
      ...(canUpdate
        ? [
          {
            id: "actions",
            enableSorting: false,
            header: () => "",
            cell: ({ row }: { row: { original: MemberRow } }) => (
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onRemove(row.original.id, row.original.user_display_name)}
                >
                  {t("removeButton")}
                </Button>
              </div>
            ),
          } as ColumnDef<MemberRow, unknown>,
        ]
        : []),
    ],
    [t, locale, dateFormatter, canUpdate, onRemove],
  );

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-sm text-red-600" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<MemberRow>
        key={reloadKey}
        name={`administrator.org-members.${orgId}`}
        endpoint={`/api/administrator/organizations/${orgId}/members`}
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "created_at", direction: "desc" }],
        }}
      />
    </div>
  );
}
