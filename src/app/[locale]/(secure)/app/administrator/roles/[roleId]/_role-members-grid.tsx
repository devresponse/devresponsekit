"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../../_components/grid/data-grid";

/**
 * Members tab for the role detail (plan §8.6 — Members).
 *
 * Reuses the shared `DataGrid` so URL-state, pagination and a11y
 * behave identically to the parent users grid. Each row's email is a
 * link into the user-detail page so the operator can pivot from
 * "users with role X" to the user's full surface in one click.
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

export function RoleMembersGrid({ roleId }: { roleId: string }) {
  const t = useTranslations("administrator.roles.members");
  const locale = useLocale();
  const intlLocale = useLocale();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }),
    [intlLocale],
  );

  const columns = useMemo<ColumnDef<MemberRow, unknown>[]>(
    () => [
      {
        id: "primary_email",
        accessorKey: "primary_email",
        header: () => t("columns.email"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/users/${row.original.app_user_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.primary_email}
          </LocaleLink>
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
        cell: ({ row }) => {
          const d = new Date(row.original.created_at);
          return Number.isNaN(d.getTime()) ? row.original.created_at : dateFormatter.format(d);
        },
      },
    ],
    [t, locale, dateFormatter],
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
