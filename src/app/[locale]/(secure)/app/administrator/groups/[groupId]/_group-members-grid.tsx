"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../../_components/grid/data-grid";

/**
 * Members tab for the group detail (ADR-0002). Reuses the shared `DataGrid`;
 * each row's email links into the user-detail page. Membership management
 * (add/remove) is performed from the user-detail Groups surface and the
 * `/api/administrator/groups/[id]/members` endpoint.
 */
interface MemberRow {
  app_user_id: string;
  primary_email: string;
  display_name: string | null;
  status: string;
  created_at: string;
}

export function GroupMembersGrid({ groupId }: { groupId: string }) {
  const t = useTranslations("administrator.groups.members");
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
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.joinedAt"),
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
      name={`administrator.group-members.${groupId}`}
      endpoint={`/api/administrator/groups/${groupId}/members`}
      columns={columns}
      options={{
        defaultPageSize: 25,
        defaultSort: [{ field: "primary_email", direction: "asc" }],
      }}
      searchable
    />
  );
}
