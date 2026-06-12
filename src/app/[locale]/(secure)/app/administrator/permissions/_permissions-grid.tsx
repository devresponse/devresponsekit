"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDialogs } from "@/components/ui/dialog-manager";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DataGrid } from "../_components/grid/data-grid";
import { RolesUsingPermissionPanel } from "./_roles-using-sheet";

/**
 * Permissions catalog grid (docs/admin-manager.md §8.7).
 *
 * Creation follows the standard new-record pattern (`permissions/new`
 * page; the page supplies the link via `headerActions`). Inline edit
 * stays in a slide-over Sheet to keep the catalog grid uncluttered,
 * and the "Used by N roles" cell opens a second sheet listing the
 * roles holding the permission so the operator can pivot directly
 * into role detail.
 */
interface PermissionRow {
  id: string;
  key: string;
  description: string | null;
  used_by_role_count: number;
}

type SheetMode =
  | { kind: "closed" }
  | { kind: "edit"; row: PermissionRow }
  | { kind: "rolesUsing"; row: PermissionRow };

export function AdministratorPermissionsGrid({
  canManage,
  headerActions,
}: {
  canManage: boolean;
  headerActions?: ReactNode;
}) {
  const t = useTranslations("administrator.permissions");
  const tErr = useTranslations("administrator.errors");
  const dialogs = useDialogs();

  const [sheet, setSheet] = useState<SheetMode>({ kind: "closed" });
  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const onDelete = useCallback(
    async (row: PermissionRow) => {
      const ok = await dialogs.confirm({
        title: t("deleteDialog.title"),
        description: t("deleteDialog.description") + "\n\n" + row.key,
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/permissions/${row.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.status === 409) {
        setRowError(tErr("permissionInUse"));
        return;
      }
      if (!res.ok) {
        setRowError(t("deleteError"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, tErr, dialogs],
  );

  const columns = useMemo<ColumnDef<PermissionRow, unknown>[]>(
    () => [
      {
        id: "key",
        accessorKey: "key",
        header: () => t("columns.key"),
        cell: ({ row }) => <code className="text-xs">{row.original.key}</code>,
      },
      {
        id: "description",
        accessorKey: "description",
        header: () => t("columns.description"),
        cell: ({ row }) => row.original.description ?? "—",
      },
      {
        id: "used_by_role_count",
        accessorKey: "used_by_role_count",
        header: () => t("columns.usedByRoleCount"),
        cell: ({ row }) => (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => setSheet({ kind: "rolesUsing", row: row.original })}
          >
            {row.original.used_by_role_count}
          </Button>
        ),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              enableSorting: false,
              header: () => t("columns.actions"),
              cell: ({ row }: { row: { original: PermissionRow } }) => (
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSheet({ kind: "edit", row: row.original })}
                  >
                    {t("editButton")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onDelete(row.original)}
                  >
                    {t("deleteButton")}
                  </Button>
                </div>
              ),
            } as ColumnDef<PermissionRow, unknown>,
          ]
        : []),
    ],
    [t, canManage, onDelete],
  );

  const closeSheet = () => setSheet({ kind: "closed" });

  return (
    <div className="space-y-3">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
          {rowError}
        </p>
      ) : null}

      <DataGrid<PermissionRow>
        key={reloadKey}
        name="administrator.permissions"
        endpoint="/api/administrator/permissions"
        columns={columns}
        headerActions={headerActions}
        options={{
          defaultPageSize: 50,
          defaultSort: [{ field: "key", direction: "asc" }],
        }}
      />

      <Sheet open={sheet.kind !== "closed"} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent side="right" className="w-full max-w-md sm:max-w-lg">
          {sheet.kind === "edit" ? (
            <EditPermissionPanel
              row={sheet.row}
              onClose={closeSheet}
              onDone={() => {
                closeSheet();
                setReloadKey((k) => k + 1);
              }}
            />
          ) : sheet.kind === "rolesUsing" ? (
            <RolesUsingPermissionPanel permissionKey={sheet.row.key} />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function EditPermissionPanel({
  row,
  onClose,
  onDone,
}: {
  row: PermissionRow;
  onClose(): void;
  onDone(): void;
}) {
  const t = useTranslations("administrator.permissions");
  const tFields = useTranslations("administrator.permissions.fields");
  const tErr = useTranslations("administrator.errors");

  const [description, setDescription] = useState(row.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/administrator/permissions/${row.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: description.trim().length > 0 ? description.trim() : null,
        }),
      });

      if (res.ok) {
        onDone();
        return;
      }
      if (res.status === 400) {
        setError(tErr("invalidBody"));
        return;
      }
      setError(t("edit.errorToast"));
    } catch {
      setError(t("edit.errorToast"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t("edit.title")}</SheetTitle>
      </SheetHeader>

      <form className="mt-4 space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-2">
          <Label htmlFor="permission-key">{tFields("key")}</Label>
          <Input id="permission-key" type="text" value={row.key} disabled />
        </div>

        <div className="space-y-2">
          <Label htmlFor="permission-description">{tFields("description")}</Label>
          <Input
            id="permission-description"
            type="text"
            maxLength={1000}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </div>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            {t("edit.submit")}
          </Button>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            {t("edit.cancel")}
          </Button>
        </div>
      </form>
    </>
  );
}
