"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { LocaleLink } from "@/components/i18n/locale-link";
import { useAppFormatter } from "@/components/i18n/format-preferences";
import { DataGrid, type GridColumnDef } from "../_components/grid/data-grid";
import { toFilterOptions, type GridFilterDescriptor } from "../_components/grid/data-grid-filters";
import { PermittedLink } from "../_components/permitted-link";
import { MEMBERSHIP_STATUS_VALUES } from "@/lib/status-values";

/**
 * Client-side memberships grid (docs/admin-manager.md §8.3).
 *
 * Cross-org search for memberships with links to both user and org details.
 * The page itself requires `admin.orgs.read`, the org page's guard; the user
 * page needs `admin.users.read`, so without it the user is plain text (F-67).
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

export function AdministratorMembershipsGrid({
  locale,
  canReadUsers,
}: {
  locale: string;
  canReadUsers: boolean;
}) {
  const t = useTranslations("administrator.memberships");
  const tGrid = useTranslations("administrator.grid");
  // F-37: the viewer's zone and date format.
  const format = useAppFormatter();

  const columns = useMemo<GridColumnDef<MembershipRow>[]>(
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
          <PermittedLink
            permitted={canReadUsers}
            locale={locale}
            href={`/app/administrator/users/${row.original.app_user_id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.user_display_name ?? row.original.app_user_id}
          </PermittedLink>
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
        cell: ({ row }) => format.date(row.original.created_at),
      },
    ],
    [t, locale, format, canReadUsers],
  );

  const filters = useMemo<GridFilterDescriptor[]>(
    () => [
      {
        name: "status",
        label: t("columns.status"),
        options: toFilterOptions(tGrid, MEMBERSHIP_STATUS_VALUES),
      },
    ],
    [t, tGrid],
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
      searchable
      filters={filters}
    />
  );
}
