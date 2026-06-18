"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../../_components/grid/data-grid";

/**
 * Roles tab for the user detail (docs/admin-manager.md §8.4).
 *
 * Read-only list of the application ROLE ASSIGNMENTS a user holds, scoped per
 * ADR-0001 by the `/roles` endpoint (org admin: own org only; superadmin: all).
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

export function UserRolesPanel({ userId }: { userId: string }) {
  const t = useTranslations("administrator.users.roles");
  const locale = useLocale();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const columns = useMemo<ColumnDef<RoleRow, unknown>[]>(
    () => [
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
    ],
    [t, locale, dateFormatter],
  );

  return (
    <DataGrid<RoleRow>
      name={`administrator.user-roles.${userId}`}
      endpoint={`/api/administrator/users/${userId}/roles`}
      columns={columns}
      options={{
        defaultPageSize: 25,
        defaultSort: [{ field: "created_at", direction: "desc" }],
      }}
    />
  );
}
