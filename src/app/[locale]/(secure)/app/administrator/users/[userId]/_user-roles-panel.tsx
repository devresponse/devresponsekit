"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../../_components/grid/data-grid";
import { RolePicker, type RoleOption } from "./_role-picker";

/**
 * Roles tab for the user detail (docs/admin-manager.md §8.4).
 *
 * Lists the application ROLE ASSIGNMENTS a user holds, scoped per ADR-0001 by
 * the `/roles` endpoint. With `admin.roles.assign` the operator can also assign
 * a role (org context derived from the chosen role) and remove an assignment,
 * via `POST`/`DELETE /api/administrator/users/[id]/app-roles`.
 */
interface RoleRow {
  id: string;
  role_id: string;
  role_key: string;
  role_name: string;
  role_description: string | null;
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  created_at: string;
}

export function UserRolesPanel({
  userId,
  canAssign = false,
}: {
  userId: string;
  canAssign?: boolean;
}) {
  const t = useTranslations("administrator.users.roles");
  const locale = useLocale();
  const dialogs = useDialogs();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<RoleOption | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const onRemove = useCallback(
    async (roleId: string, organizationId: string, roleName: string) => {
      const ok = await dialogs.confirm({
        title: t("removeConfirm"),
        description: roleName,
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/users/${userId}/app-roles`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId, organizationId }),
      });
      if (!res.ok) {
        setRowError(t("removeError"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, userId, dialogs],
  );

  const onAssign = useCallback(async () => {
    if (!selectedRole) return;
    setAssigning(true);
    setAssignError(null);
    try {
      const res = await fetch(`/api/administrator/users/${userId}/app-roles`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roleId: selectedRole.id,
          organizationId: selectedRole.organization_id,
        }),
      });
      if (!res.ok) {
        setAssignError(t("assignError"));
        return;
      }
      setAssignOpen(false);
      setSelectedRole(null);
      setReloadKey((k) => k + 1);
    } catch {
      setAssignError(t("assignError"));
    } finally {
      setAssigning(false);
    }
  }, [selectedRole, userId, t]);

  const columns = useMemo<ColumnDef<RoleRow, unknown>[]>(() => {
    const base: ColumnDef<RoleRow, unknown>[] = [
      {
        id: "role_name",
        accessorKey: "role_name",
        header: () => t("columns.role"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/roles/${row.original.role_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.role_name}
          </LocaleLink>
        ),
      },
      {
        id: "role_key",
        accessorKey: "role_key",
        header: () => t("columns.key"),
        cell: ({ row }) => <code className="text-xs">{row.original.role_key}</code>,
      },
      {
        id: "organization_name",
        accessorKey: "organization_name",
        header: () => t("columns.organization"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/organizations/${row.original.organization_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.organization_name}
          </LocaleLink>
        ),
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.assigned"),
        cell: ({ row }) => {
          const d = new Date(row.original.created_at);
          return Number.isNaN(d.getTime()) ? row.original.created_at : dateFormatter.format(d);
        },
      },
    ];
    if (!canAssign) return base;
    return [
      ...base,
      {
        id: "actions",
        enableSorting: false,
        header: () => "",
        cell: ({ row }: { row: { original: RoleRow } }) => (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onRemove(row.original.role_id, row.original.organization_id, row.original.role_name)
              }
            >
              {t("removeButton")}
            </Button>
          </div>
        ),
      } as ColumnDef<RoleRow, unknown>,
    ];
  }, [t, locale, dateFormatter, canAssign, onRemove]);

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<RoleRow>
        key={reloadKey}
        name={`administrator.user-roles.${userId}`}
        endpoint={`/api/administrator/users/${userId}/roles`}
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "created_at", direction: "desc" }],
        }}
        headerActions={
          canAssign ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setAssignError(null);
                setSelectedRole(null);
                setAssignOpen(true);
              }}
            >
              {t("assignButton")}
            </Button>
          ) : undefined
        }
      />
      {canAssign ? (
        <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("dialog.title")}</DialogTitle>
              <DialogDescription>{t("dialog.description")}</DialogDescription>
            </DialogHeader>
            <RolePicker value={selectedRole} onChange={setSelectedRole} />
            {assignError ? (
              <p className="text-destructive text-sm" role="alert">
                {assignError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAssignOpen(false)}
                disabled={assigning}
              >
                {t("dialog.cancel")}
              </Button>
              <Button
                type="button"
                onClick={onAssign}
                disabled={assigning || selectedRole === null}
              >
                {t("dialog.submit")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
