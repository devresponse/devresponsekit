"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useAppFormatter } from "@/components/i18n/format-preferences";
import { DataGrid, type GridColumnDef } from "../../_components/grid/data-grid";
import { PermittedLink } from "../../_components/permitted-link";

/**
 * Members tab for the role detail (docs/admin-manager.md §8.4 — Members).
 *
 * Reuses the shared `DataGrid` so URL-state, pagination and a11y
 * behave identically to the parent users grid. Each row's email is a
 * link into the user-detail page so the operator can pivot from
 * "users with role X" to the user's full surface in one click, for a
 * viewer who may open that page (`admin.users.read`); anyone else sees
 * the email as plain text (F-67).
 */
interface MemberRow {
  app_user_id: string;
  primary_email: string;
  display_name: string | null;
  status: string;
  organization_id: string | null;
  organization_name: string | null;
  created_at: string;
}

export function RoleMembersGrid({
  roleId,
  canReadUsers,
}: {
  roleId: string;
  canReadUsers: boolean;
}) {
  const t = useTranslations("administrator.roles.members");
  const locale = useLocale();
  // F-37: the viewer's zone and date format.
  const format = useAppFormatter();

  const columns = useMemo<GridColumnDef<MemberRow>[]>(
    () => [
      {
        id: "primary_email",
        accessorKey: "primary_email",
        header: () => t("columns.email"),
        cell: ({ row }) => (
          <PermittedLink
            permitted={canReadUsers}
            locale={locale}
            href={`/app/administrator/users/${row.original.app_user_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.primary_email}
          </PermittedLink>
        ),
      },
      {
        id: "display_name",
        accessorKey: "display_name",
        header: () => t("columns.name"),
        cell: ({ row }) => row.original.display_name ?? "—",
      },
      {
        id: "organization_name",
        accessorKey: "organization_name",
        header: () => t("columns.organization"),
        cell: ({ row }) => row.original.organization_name ?? "—",
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.assignedAt"),
        cell: ({ row }) => format.date(row.original.created_at),
      },
    ],
    [t, locale, format, canReadUsers],
  );

  return (
    <DataGrid<MemberRow>
      name={`administrator.role-members.${roleId}`}
      endpoint={`/api/administrator/roles/${roleId}/members`}
      columns={columns}
      options={{
        defaultPageSize: 25,
        defaultSort: [{ field: "primary_email", direction: "asc" }],
      }}
    />
  );
}
