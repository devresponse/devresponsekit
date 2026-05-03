"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../_components/grid/data-grid";
import type { BulkActionDescriptor } from "../_components/grid/data-grid-toolbar";
import { useGridSelection } from "../_components/grid/use-grid-selection";

/**
 * Client-side users grid for the Administrator workspace
 * (docs/admin-manager.md §8.2).
 *
 * Phase 2 wired the foundation columns (email, name, status, created).
 * Phase 3 layered on the navigation affordance: the email cell links
 * to the user detail page so the grid is the entry point for every
 * per-user action.
 *
 * Phase 7 layers on row selection, bulk actions (approve/block/ban/
 * soft-delete) wired to `POST /api/administrator/users/bulk`, and an
 * "Export CSV" button that downloads the current view via
 * `/api/administrator/export/users`. The bulk actions reload the grid
 * via `reloadKey` once the server confirms the action — re-mounting
 * the inner `DataGrid` is the simplest way to force a fresh fetch
 * without exposing reload through the existing hook surface.
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

type BulkActionKey = "approve" | "block" | "ban" | "soft_delete";

export function AdministratorUsersGrid({ locale }: { locale: string }) {
  const t = useTranslations("administrator.users.columns");
  const tBulk = useTranslations("administrator.users.bulk");
  const intlLocale = useLocale();
  const selection = useGridSelection();
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Memoize the formatter — `Intl.DateTimeFormat` construction is the
  // expensive part; reusing it across rows and renders keeps the grid
  // cheap.
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }),
    [intlLocale],
  );

  const columns = useMemo<ColumnDef<UserRow, unknown>[]>(
    () => [
      {
        id: "primary_email",
        accessorKey: "primary_email",
        header: () => t("email"),
        cell: ({ row }) => (
          <LocaleLink
            locale={locale}
            href={`/app/administrator/users/${row.original.id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.original.primary_email}
          </LocaleLink>
        ),
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
    [t, dateFormatter, locale],
  );

  const runBulkAction = useCallback(
    async (action: BulkActionKey, options: { reason?: string } = {}) => {
      if (busy) return;
      // Mirror the server cap so the UI doesn't optimistically allow a
      // batch that the server will reject.
      const explicitIds = Array.from(selection.selectedIds);
      if (selection.mode === "page" && explicitIds.length === 0) return;

      setBusy(true);
      try {
        const body: Record<string, unknown> = { action, reason: options.reason };
        if (selection.mode === "all") {
          body.ids = "*";
          // Forward the same allow-listed filter set the list endpoint
          // honours so "select all matching" cannot pivot to other
          // columns. We read directly from the URL — same source the
          // grid is already reading.
          const params = new URLSearchParams(window.location.search);
          const filters: Record<string, string | string[]> = {};
          const status = params.getAll("filter[status]");
          if (status.length === 1) filters.status = status[0]!;
          else if (status.length > 1) filters.status = status;
          const q = params.get("q");
          if (q) filters.q = q;
          body.filters = filters;
        } else {
          body.ids = explicitIds;
        }

        const res = await fetch("/api/administrator/users/bulk", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          alert(tBulk("rateLimitedToast"));
          return;
        }
        if (!res.ok) {
          alert(tBulk("errorToast"));
          return;
        }

        const result = (await res.json()) as {
          succeeded: number;
          failed: number;
          attempted: number;
        };
        const message =
          result.failed > 0
            ? tBulk("partialFailureToast", {
                action,
                succeeded: result.succeeded,
                attempted: result.attempted,
                failed: result.failed,
              })
            : tBulk("successToast", { action, succeeded: result.succeeded });
        // Native alert is good enough for v1 — toast/sonner can be
        // wired in a follow-up without changing the API surface.
        alert(message);
        selection.clear();
        setReloadKey((k) => k + 1);
      } finally {
        setBusy(false);
      }
    },
    [busy, selection, tBulk],
  );

  const bulkActions = useMemo<BulkActionDescriptor[]>(
    () => [
      {
        key: "approve",
        label: tBulk("approve"),
        onSelect: () => void runBulkAction("approve"),
      },
      {
        key: "block",
        label: tBulk("block"),
        onSelect: () => void runBulkAction("block"),
      },
      {
        key: "ban",
        label: tBulk("ban"),
        destructive: true,
        onSelect: () => {
          const reason = window.prompt(tBulk("reasonPrompt"));
          if (!reason) return;
          void runBulkAction("ban", { reason });
        },
      },
      {
        key: "soft_delete",
        label: tBulk("softDelete"),
        destructive: true,
        onSelect: () => {
          if (!window.confirm(tBulk("confirmDelete"))) return;
          void runBulkAction("soft_delete");
        },
      },
    ],
    [tBulk, runBulkAction],
  );

  return (
    <DataGrid<UserRow>
      key={reloadKey}
      name="administrator.users"
      endpoint="/api/administrator/users"
      columns={columns}
      options={{
        defaultPageSize: 25,
        defaultSort: [{ field: "created_at", direction: "desc" }],
      }}
      selection={{ state: selection, getRowId: (row) => row.id }}
      bulkActions={bulkActions}
      exportResource="users"
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

