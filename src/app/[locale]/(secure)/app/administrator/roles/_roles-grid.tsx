"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../_components/grid/data-grid";

/**
 * Client-side roles grid (docs/admin-manager.md §8.5).
 *
 * Mirrors the structure of the users grid: the `key` cell is the
 * navigation affordance into the role-detail page, and per-row "Delete"
 * / "Duplicate" actions are inline buttons gated by the caller's
 * permissions. Per-row destructive actions go through a confirm prompt
 * and surface the canonical `role_in_use` 409 inline so the user
 * immediately sees why a delete was refused.
 */
interface RoleRow {
  id: string;
  organization_id: string | null;
  key: string;
  name: string;
  description: string | null;
  permission_count: number;
  member_count: number;
  created_at: string;
}

export function AdministratorRolesGrid({
  locale,
  canDelete,
  canDuplicate,
}: {
  locale: string;
  canDelete: boolean;
  canDuplicate: boolean;
}) {
  const t = useTranslations("administrator.roles");
  const tErr = useTranslations("administrator.errors");
  const intlLocale = useLocale();
  const router = useRouter();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }),
    [intlLocale],
  );

  // Reload key — bumped after every successful delete/duplicate so the
  // grid re-fetches without a full page reload.
  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const onDelete = useCallback(
    async (id: string, key: string) => {
      // Use a native confirm to keep the per-row footprint small. A
      // proper AlertDialog can be added later without touching the API.
      if (!window.confirm(t("deleteDialog.description") + "\n\n" + key)) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/roles/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.status === 409) {
        setRowError(tErr("roleInUse"));
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

  const onDuplicate = useCallback(
    async (id: string) => {
      if (!window.confirm(t("duplicateConfirm"))) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/roles/${id}/duplicate`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.status === 201) {
        const body = (await res.json()) as { id?: string };
        if (body.id) {
          router.push(`/${locale}/app/administrator/roles/${body.id}`);
          return;
        }
      }
      setRowError(t("duplicateError"));
    },
    [t, locale, router],
  );

  const columns = useMemo<ColumnDef<RoleRow, unknown>[]>(
    () => [
      {
        id: "key",
        accessorKey: "key",
        header: () => t("columns.key"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/roles/${row.original.id}`}
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
        id: "scope",
        header: () => t("columns.scope"),
        cell: ({ row }) =>
          row.original.organization_id === null ? (
            <Badge variant="outline">{t("scope.global")}</Badge>
          ) : (
            <Badge variant="outline">{t("scope.org")}</Badge>
          ),
      },
      {
        id: "permission_count",
        accessorKey: "permission_count",
        header: () => t("columns.permissionCount"),
        cell: ({ row }) => row.original.permission_count,
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
        cell: ({ row }) => formatDate(row.original.created_at, dateFormatter),
      },
      ...(canDelete || canDuplicate
        ? [
            {
              id: "actions",
              header: () => "",
              cell: ({ row }: { row: { original: RoleRow } }) => (
                <div className="flex justify-end gap-2">
                  {canDuplicate ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onDuplicate(row.original.id)}
                    >
                      {t("duplicateButton")}
                    </Button>
                  ) : null}
                  {canDelete ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onDelete(row.original.id, row.original.key)}
                      // Avoid showing a delete button for in-use roles?
                      // The server still enforces the rule and the inline
                      // error keeps the UX honest without a per-row
                      // database round-trip.
                    >
                      {t("deleteButton")}
                    </Button>
                  ) : null}
                </div>
              ),
            } as ColumnDef<RoleRow, unknown>,
          ]
        : []),
    ],
    [t, locale, dateFormatter, canDelete, canDuplicate, onDelete, onDuplicate],
  );

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-sm text-red-600" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<RoleRow>
        key={reloadKey}
        name="administrator.roles"
        endpoint="/api/administrator/roles"
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "key", direction: "asc" }],
        }}
      />
    </div>
  );
}

function formatDate(value: string, formatter: Intl.DateTimeFormat): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatter.format(d);
}
