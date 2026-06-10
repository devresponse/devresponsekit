"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../_components/grid/data-grid";

/**
 * Client-side memberships grid (docs/admin-manager.md §19).
 *
 * Cross-org search for memberships with links to both user and org details.
 */
interface MembershipRow {
  id: string;
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  app_user_id: string;
  user_display_name: string | null;
  status: string;
  source_provider: string | null;
  created_at: string;
}

export function AdministratorMembershipsGrid({ locale }: { locale: string }) {
  const t = useTranslations("administrator.memberships");
  const intlLocale = useLocale();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }),
    [intlLocale],
  );

  const columns = useMemo<ColumnDef<MembershipRow, unknown>[]>(
    () => [
      {
        id: "organization_slug",
        accessorKey: "organization_slug",
        header: () => t("columns.organization"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/organizations/${row.original.organization_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            <code className="text-xs">{row.original.organization_slug}</code>
          </LocaleLink>
        ),
      },
      {
        id: "user_display_name",
        accessorKey: "user_display_name",
        header: () => t("columns.user"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/users/${row.original.app_user_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.user_display_name ?? row.original.app_user_id}
          </LocaleLink>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "source_provider",
        accessorKey: "source_provider",
        header: () => t("columns.source"),
        cell: ({ row }) => row.original.source_provider ?? "—",
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.createdAt"),
        cell: ({ row }) => {
          const d = new Date(row.original.created_at);
          return Number.isNaN(d.getTime()) ? row.original.created_at : dateFormatter.format(d);
        },
      },
    ],
    [t, locale, dateFormatter],
  );

  return (
    <DataGrid<MembershipRow>
      name="administrator.memberships"
      endpoint="/api/administrator/memberships"
      columns={columns}
      options={{
        defaultPageSize: 25,
        defaultSort: [{ field: "created_at", direction: "desc" }],
      }}
    />
  );
}
