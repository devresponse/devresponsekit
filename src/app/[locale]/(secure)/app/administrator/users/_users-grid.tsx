"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataGrid } from "../_components/grid/data-grid";

/**
 * Client-side users grid for the Administrator workspace
 * (docs/admin-manager.md §8.2 — Phase 2 subset).
 *
 * Only the foundation columns are wired in this PR: email, display
 * name, app status badge, created. Phase 3 layers on the Better Auth
 * `banned` / role columns, row actions and bulk actions.
 */
interface UserRow {
  id: string;
  better_auth_user_id: string;
  primary_email: string;
  display_name: string | null;
  status: string;
  preferred_locale: string;
  created_at: string;
  updated_at: string;
}

export function AdministratorUsersGrid() {
  const t = useTranslations("administrator.users.columns");
  const locale = useLocale();
  // Memoize the formatter — `Intl.DateTimeFormat` construction is the
  // expensive part; reusing it across rows and renders keeps the grid
  // cheap.
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const columns = useMemo<ColumnDef<UserRow, unknown>[]>(
    () => [
      {
        id: "primary_email",
        accessorKey: "primary_email",
        header: () => t("email"),
      },
      {
        id: "display_name",
        accessorKey: "display_name",
        header: () => t("displayName"),
        cell: ({ row }) => row.original.display_name ?? "—",
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("status"),
        cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("createdAt"),
        cell: ({ row }) => formatDate(row.original.created_at, dateFormatter),
      },
    ],
    [t, dateFormatter],
  );

  return (
    <DataGrid<UserRow>
      name="administrator.users"
      endpoint="/api/administrator/users"
      columns={columns}
      options={{
        defaultPageSize: 25,
        defaultSort: [{ field: "created_at", direction: "desc" }],
      }}
    />
  );
}

function formatDate(value: string, formatter: Intl.DateTimeFormat): string {
  // Defensive: the server returns ISO timestamps. Render falls back to
  // the raw string if parsing fails so the cell never turns into
  // "Invalid Date".
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatter.format(d);
}
