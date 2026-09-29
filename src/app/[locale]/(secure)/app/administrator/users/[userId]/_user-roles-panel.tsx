"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import { useAppFormatter } from "@/components/i18n/format-preferences";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataGrid, type GridColumnDef } from "../../_components/grid/data-grid";
import { PermittedLink } from "../../_components/permitted-link";
import { RolePicker, type RoleOption } from "./_role-picker";

/**
 * Roles tab for the user detail (docs/admin-manager.md §8.1).
 *
 * Lists the application ROLE ASSIGNMENTS a user holds, scoped per ADR-0001 by
 * the `/roles` endpoint. With `admin.roles.assign` the operator can also assign
 * a role (org context derived from the chosen role; the picker offers only the
 * roles of orgs the user is an active member of, F-154) and remove an
 * assignment, via `POST`/`DELETE /api/administrator/users/[id]/app-roles`.
 *
 * F-67: assigning also needs `admin.roles.read`, because the picker lists
 * roles from `GET /api/administrator/roles`; removing does not. The role and
 * organization names link to their pages only for a viewer who passes those
 * pages' guards (`admin.roles.read`, `admin.orgs.read`), and are plain text
 * otherwise.
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
  canReadRoles,
  canReadOrgs,
}: {
  userId: string;
  canAssign?: boolean;
  canReadRoles: boolean;
  canReadOrgs: boolean;
}) {
  const canPick = canAssign && canReadRoles;
  const t = useTranslations("administrator.users.roles");
  const tErr = useTranslations("administrator.errors");
  const locale = useLocale();
  const dialogs = useDialogs();
  // F-37: the viewer's zone and date format.
  const format = useAppFormatter();

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
      // REVOKE-2: the 409 `last_superadmin` refusal is the most consequential
      // one in the console — the platform declining to let itself be left with
      // no administrator. A generic "couldn't remove" here invites the operator
      // to go looking for another route, so name the cause, using the same
      // read-the-envelope-code pattern the organizations and enterprise-apps
      // grids use for their own 409s.
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
    [t, tErr, userId, dialogs],
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

  const columns = useMemo<GridColumnDef<RoleRow>[]>(() => {
    const base: GridColumnDef<RoleRow>[] = [
      {
        id: "role_name",
        accessorKey: "role_name",
        header: () => t("columns.role"),
        cell: ({ row }) => (
          <PermittedLink
            permitted={canReadRoles}
            locale={locale}
            href={`/app/administrator/roles/${row.original.role_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.role_name}
          </PermittedLink>
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
          <PermittedLink
            permitted={canReadOrgs}
            locale={locale}
            href={`/app/administrator/organizations/${row.original.organization_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.organization_name}
          </PermittedLink>
        ),
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.assigned"),
        cell: ({ row }) => format.date(row.original.created_at),
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
      } as GridColumnDef<RoleRow>,
    ];
  }, [t, locale, format, canAssign, canReadRoles, canReadOrgs, onRemove]);

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
          canPick ? (
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
      {canPick ? (
        <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("dialog.title")}</DialogTitle>
              <DialogDescription>{t("dialog.description")}</DialogDescription>
            </DialogHeader>
            <RolePicker userId={userId} value={selectedRole} onChange={setSelectedRole} />
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
