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
 * Memberships tab for the user detail (docs/admin-manager.md §8.1).
 *
 * Shows all organization memberships for a specific user.
 */
interface MembershipRow {
  id: string;
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  status: string;
  source_provider: string | null;
  created_at: string;
}

export function UserMembershipsPanel({
  userId,
  canUpdate,
}: {
  userId: string;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.users.memberships");
  const locale = useLocale();
  const dialogs = useDialogs();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const onRemove = useCallback(
    async (membershipId: string, orgSlug: string) => {
      const ok = await dialogs.confirm({
        title: t("removeConfirm"),
        description: orgSlug,
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/users/${userId}/memberships`, {
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
    [t, userId, dialogs],
  );

  const columns = useMemo<ColumnDef<MembershipRow, unknown>[]>(
    () => [
      {
        id: "organization_slug",
        accessorKey: "organization_slug",
        header: () => t("columns.organization"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/organizations/${row.original.organization_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            <code className="text-xs">{row.original.organization_slug}</code>
          </LocaleLink>
        ),
      },
      {
        id: "organization_name",
        accessorKey: "organization_name",
        header: () => t("columns.orgName"),
        cell: ({ row }) => row.original.organization_name,
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
          return Number.isNaN(d.getTime()) ? row.original.created_at : dateFormatter.format(d);
        },
      },
      ...(canUpdate
        ? [
            {
              id: "actions",
              enableSorting: false,
              header: () => "",
              cell: ({ row }: { row: { original: MembershipRow } }) => (
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onRemove(row.original.id, row.original.organization_slug)}
                  >
                    {t("removeButton")}
                  </Button>
                </div>
              ),
            } as ColumnDef<MembershipRow, unknown>,
          ]
        : []),
    ],
    [t, locale, dateFormatter, canUpdate, onRemove],
  );

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<MembershipRow>
        key={reloadKey}
        name={`administrator.user-memberships.${userId}`}
        endpoint={`/api/administrator/users/${userId}/memberships`}
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "created_at", direction: "desc" }],
        }}
      />
    </div>
  );
}
