"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../_components/grid/data-grid";
import { toFilterOptions, type GridFilterDescriptor } from "../_components/grid/data-grid-filters";

/** Organization statuses — the allow-listed `status` filter values. */
const ORG_STATUSES = ["active", "pending", "suspended", "archived"] as const;

/**
 * Client-side organizations grid (docs/admin-manager.md §19).
 *
 * Mirrors the structure of the roles grid: the `slug` cell is the
 * navigation affordance into the org-detail page, and per-row "Delete"
 * action is an inline button gated by the caller's permissions.
 * Per-row destructive actions go through a confirm prompt and surface
 * the canonical `organization_not_empty` or `organization_is_default`
 * 409 inline so the user immediately sees why a delete was refused.
 */
interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_default: boolean;
  member_count: number;
  created_at: string;
}

export function AdministratorOrganizationsGrid({
  locale,
  canDelete,
  headerActions,
}: {
  locale: string;
  canDelete: boolean;
  headerActions?: ReactNode;
}) {
  const t = useTranslations("administrator.orgs");
  const tErr = useTranslations("administrator.errors");
  const tGrid = useTranslations("administrator.grid");
  const intlLocale = useLocale();
  const dialogs = useDialogs();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }),
    [intlLocale],
  );

  // Reload key — bumped after every successful delete so the grid
  // re-fetches without a full page reload.
  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const onDelete = useCallback(
    async (id: string, slug: string) => {
      const ok = await dialogs.confirm({
        title: t("deleteDialog.title"),
        description: t("deleteDialog.description") + "\n\n" + slug,
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/organizations/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        if (body.error === "organization_not_empty") {
          setRowError(tErr("organizationNotEmpty"));
        } else if (body.error === "organization_is_default") {
          setRowError(tErr("organizationIsDefault"));
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
    [dialogs, t, tErr],
  );

  const columns = useMemo<ColumnDef<OrgRow, unknown>[]>(
    () => [
      {
        id: "slug",
        accessorKey: "slug",
        header: () => t("columns.slug"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/organizations/${row.original.id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            <code className="text-xs">{row.original.slug}</code>
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
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "is_default",
        accessorKey: "is_default",
        header: () => t("columns.isDefault"),
        cell: ({ row }) =>
          row.original.is_default ? <Badge variant="secondary">{t("defaultYes")}</Badge> : null,
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
      ...(canDelete
        ? [
            {
              id: "actions",
              enableSorting: false,
              header: () => "",
              cell: ({ row }: { row: { original: OrgRow } }) => (
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onDelete(row.original.id, row.original.slug)}
                  >
                    {t("deleteButton")}
                  </Button>
                </div>
              ),
            } as ColumnDef<OrgRow, unknown>,
          ]
        : []),
    ],
    [t, locale, dateFormatter, canDelete, onDelete],
  );

  const filters = useMemo<GridFilterDescriptor[]>(
    () => [
      { name: "status", label: t("columns.status"), options: toFilterOptions(tGrid, ORG_STATUSES) },
      {
        name: "is_default",
        label: t("columns.isDefault"),
        options: toFilterOptions(tGrid, ["true", "false"]),
      },
    ],
    [t, tGrid],
  );

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<OrgRow>
        key={reloadKey}
        name="administrator.orgs"
        endpoint="/api/administrator/organizations"
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "slug", direction: "asc" }],
        }}
        searchable
        filters={filters}
        headerActions={headerActions}
      />
    </div>
  );
}

function formatDate(value: string, formatter: Intl.DateTimeFormat): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatter.format(d);
}
