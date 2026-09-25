"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import { useAppFormatter } from "@/components/i18n/format-preferences";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid, type GridColumnDef } from "../../_components/grid/data-grid";

/**
 * Members tab for the organization detail (docs/admin-manager.md §8.2).
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
  const tErr = useTranslations("administrator.errors");
  const locale = useLocale();
  const dialogs = useDialogs();
  // F-37: the viewer's zone and date format.
  const format = useAppFormatter();

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
      // REVOKE-2: name the last-superadmin refusal rather than showing the
      // generic remove error — see the note in the user roles panel.
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setRowError(body?.error === "last_superadmin" ? tErr("lastSuperadmin") : t("removeError"));
        return;
      }
      if (!res.ok) {
        setRowError(t("removeError"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, tErr, orgId, dialogs],
  );

  const columns = useMemo<GridColumnDef<MemberRow>[]>(
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
        cell: ({ row }) => format.date(row.original.created_at),
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
            } as GridColumnDef<MemberRow>,
          ]
        : []),
    ],
    [t, locale, format, canUpdate, onRemove],
  );

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
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
