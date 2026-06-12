"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDialogs } from "@/components/ui/dialog-manager";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DataGrid } from "../_components/grid/data-grid";
import { RolesUsingPermissionPanel } from "./_roles-using-sheet";

/**
 * Permissions catalog grid (docs/admin-manager.md §8.7).
 *
 * Inline create + edit affordances live in a slide-over Sheet to keep
 * the catalog grid uncluttered. The "Used by N roles" cell opens a
 * second sheet listing the roles holding the permission so the
 * operator can pivot directly into role detail.
 */
interface PermissionRow {
  id: string;
  key: string;
  description: string | null;
  used_by_role_count: number;
}

type SheetMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; row: PermissionRow }
  | { kind: "rolesUsing"; row: PermissionRow };

export function AdministratorPermissionsGrid({ canManage }: { canManage: boolean }) {
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
      {canManage ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setSheet({ kind: "create" })}>
            {t("newButton")}
          </Button>
        </div>
      ) : null}

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
        options={{
          defaultPageSize: 50,
          defaultSort: [{ field: "key", direction: "asc" }],
        }}
      />

      <Sheet open={sheet.kind !== "closed"} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent side="right" className="w-full max-w-md sm:max-w-lg">
          {sheet.kind === "create" ? (
            <PermissionFormPanel
              mode="create"
              onClose={closeSheet}
              onDone={() => {
                closeSheet();
                setReloadKey((k) => k + 1);
              }}
            />
          ) : sheet.kind === "edit" ? (
            <PermissionFormPanel
              mode="edit"
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

const KEY_RE = /^[a-zA-Z0-9_.\-:]+$/;

function PermissionFormPanel({
  mode,
  row,
  onClose,
  onDone,
}: {
  mode: "create" | "edit";
  row?: PermissionRow;
  onClose(): void;
  onDone(): void;
}) {
  const t = useTranslations("administrator.permissions");
  const tFields = useTranslations("administrator.permissions.fields");
  const tErr = useTranslations("administrator.errors");

  const [key, setKey] = useState(row?.key ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (mode === "create") {
      if (!KEY_RE.test(key) || key.length === 0) {
        setError(tErr("invalidBody"));
        return;
      }
    }

    setSaving(true);
    try {
      let res: Response;
      if (mode === "create") {
        res = await fetch("/api/administrator/permissions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: key.trim(),
            description: description.trim() || undefined,
          }),
        });
      } else {
        res = await fetch(`/api/administrator/permissions/${row!.id}`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            description: description.trim().length > 0 ? description.trim() : null,
          }),
        });
      }

      if (res.ok) {
        onDone();
        return;
      }
      if (res.status === 409) {
        setError(tErr("keyTaken"));
        return;
      }
      if (res.status === 400) {
        setError(tErr("invalidBody"));
        return;
      }
      setError(mode === "create" ? t("new.errorToast") : t("edit.errorToast"));
    } catch {
      setError(mode === "create" ? t("new.errorToast") : t("edit.errorToast"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{mode === "create" ? t("new.title") : t("edit.title")}</SheetTitle>
        {mode === "create" ? <SheetDescription>{t("new.description")}</SheetDescription> : null}
      </SheetHeader>

      <form className="mt-4 space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-2">
          <Label htmlFor="permission-key">{tFields("key")}</Label>
          <Input
            id="permission-key"
            type="text"
            required
            maxLength={120}
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            disabled={mode === "edit"}
          />
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
            {mode === "create" ? t("new.submit") : t("edit.submit")}
          </Button>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            {mode === "create" ? t("new.cancel") : t("edit.cancel")}
          </Button>
        </div>
      </form>
    </>
  );
}
