"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import { useAppFormatter } from "@/components/i18n/format-preferences";
import { DataGrid, type GridColumnDef } from "../../_components/grid/data-grid";

/**
 * Providers tab for the organization detail (docs/admin-manager.md §8.2).
 *
 * Shows the provider bindings (e.g., GitHub orgs) linked to this organization.
 */
interface BindingRow {
  id: string;
  provider: string;
  provider_organization_key: string;
  display_name: string | null;
  created_at: string;
}

export function OrganizationProvidersGrid({
  orgId,
  canUpdate,
}: {
  orgId: string;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.orgs.providers");
  const dialogs = useDialogs();
  // F-37: the viewer's zone and date format.
  const format = useAppFormatter();

  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const onRemove = useCallback(
    async (bindingId: string, provider: string, key: string) => {
      const ok = await dialogs.confirm({
        title: t("removeConfirm"),
        description: `${provider}: ${key}`,
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/organizations/${orgId}/provider-bindings`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindingIds: [bindingId] }),
      });
      if (!res.ok) {
        setRowError(t("removeError"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, orgId, dialogs],
  );

  const columns = useMemo<GridColumnDef<BindingRow>[]>(
    () => [
      {
        id: "provider",
        accessorKey: "provider",
        header: () => t("columns.provider"),
        cell: ({ row }) => row.original.provider,
      },
      {
        id: "provider_organization_key",
        accessorKey: "provider_organization_key",
        header: () => t("columns.key"),
        cell: ({ row }) => (
          <code className="text-xs">{row.original.provider_organization_key}</code>
        ),
      },
      {
        id: "display_name",
        accessorKey: "display_name",
        header: () => t("columns.displayName"),
        cell: ({ row }) => row.original.display_name ?? "—",
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.boundAt"),
        cell: ({ row }) => format.date(row.original.created_at),
      },
      ...(canUpdate
        ? [
            {
              id: "actions",
              enableSorting: false,
              header: () => "",
              cell: ({ row }: { row: { original: BindingRow } }) => (
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onRemove(
                        row.original.id,
                        row.original.provider,
                        row.original.provider_organization_key,
                      )
                    }
                  >
                    {t("removeButton")}
                  </Button>
                </div>
              ),
            } as GridColumnDef<BindingRow>,
          ]
        : []),
    ],
    [t, format, canUpdate, onRemove],
  );

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<BindingRow>
        key={reloadKey}
        name={`administrator.org-providers.${orgId}`}
        endpoint={`/api/administrator/organizations/${orgId}/provider-bindings`}
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "created_at", direction: "desc" }],
        }}
      />
    </div>
  );
}
