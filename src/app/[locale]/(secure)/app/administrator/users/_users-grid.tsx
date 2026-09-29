"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { useDialogs } from "@/components/ui/dialog-manager";
import { LocaleLink } from "@/components/i18n/locale-link";
import { useAppFormatter } from "@/components/i18n/format-preferences";
import { MAX_BULK_IDS } from "@/lib/admin/bulk-limits";
import { APP_USER_STATUS_VALUES } from "@/lib/status-values";
import { DataGrid, type GridColumnDef } from "../_components/grid/data-grid";
import { toFilterOptions, type GridFilterDescriptor } from "../_components/grid/data-grid-filters";
import type { BulkActionDescriptor } from "../_components/grid/data-grid-toolbar";
import { useGridSelection } from "../_components/grid/use-grid-selection";

/**
 * Client-side users grid for the Administrator workspace
 * (docs/admin-manager.md §8.1).
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
  /** Org name(s) the user belongs to — server-scoped to what the caller may see. */
  organization_names: string | null;
}

type BulkActionKey = "approve" | "block" | "ban" | "soft_delete";

export function AdministratorUsersGrid({
  locale,
  headerActions,
}: {
  locale: string;
  headerActions?: ReactNode;
}) {
  const t = useTranslations("administrator.users.columns");
  const tBulk = useTranslations("administrator.users.bulk");
  const tGrid = useTranslations("administrator.grid");
  const selection = useGridSelection();
  const dialogs = useDialogs();
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // F-37: the viewer's zone and formats (the same ones the server-rendered
  // Administrator overview uses), memoized by the hook across renders.
  const format = useAppFormatter();

  const columns = useMemo<GridColumnDef<UserRow>[]>(
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
        id: "organization_names",
        accessorKey: "organization_names",
        header: () => t("organization"),
        // Aggregated across the user's memberships server-side, so it is not a
        // sortable column (no single backing field to ORDER BY).
        enableSorting: false,
        cell: ({ row }) => row.original.organization_names ?? "—",
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("status"),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("createdAt"),
        cell: ({ row }) => format.dateTime(row.original.created_at),
      },
    ],
    [t, format, locale],
  );

  // Mirror the server cap so the UI cannot submit a batch the server
  // will reject (review #34). `MAX_BULK_IDS` is imported from the same
  // module the route's Zod schema uses, so the two cannot drift, and
  // the operator gets an actionable message naming the limit instead of
  // the generic "Bulk action failed." a 400 would produce. Page mode counts
  // the ticked rows; "select all matching" counts the matches the toolbar
  // offered, and the server refuses it too when more users match (F-62).
  // Every action checks this before its own dialog (and so before
  // `runBulkAction`), so nobody confirms a batch that is then refused.
  const refuseOverCap = useCallback(async (): Promise<boolean> => {
    const count =
      selection.mode === "all" ? (selection.matchingTotal ?? 0) : selection.selectedIds.size;
    if (count <= MAX_BULK_IDS) return false;
    await dialogs.notify({
      description: tBulk("tooManyToast", { max: MAX_BULK_IDS }),
      variant: "destructive",
    });
    return true;
  }, [selection, dialogs, tBulk]);

  const runBulkAction = useCallback(
    async (action: BulkActionKey, options: { reason?: string } = {}) => {
      if (busy) return;
      // Nothing to send in page mode with an empty selection (the server
      // rejects an empty ids array).
      const explicitIds = Array.from(selection.selectedIds);
      if (selection.mode === "page" && explicitIds.length === 0) return;

      setBusy(true);
      try {
        const body: Record<string, unknown> = { action, reason: options.reason };
        if (selection.mode === "all") {
          body.ids = "*";
          // Forward the same allow-listed filter set the list endpoint
          // honours so "select all matching" cannot pivot to other
          // columns: the search and status filter the selection was made
          // under, never the URL's current ones (F-114). This handler may
          // resume after a dialog, still holding the selection of the render
          // it was clicked in, while the URL moved on under the dialog (the
          // search box commits on a timer); the confirmation named this
          // selection's count.
          const { q, filters: scoped } = selection.scope;
          const filters: Record<string, string | string[]> = {};
          if (scoped.status !== undefined) filters.status = scoped.status;
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
          await dialogs.notify({ description: tBulk("rateLimitedToast"), variant: "destructive" });
          return;
        }
        if (!res.ok) {
          // F-62: more users match "select all" than one batch may act on,
          // and the server applied nothing. Say so, with the limit, rather
          // than the generic failure.
          const refusal =
            res.status === 400
              ? ((await res.json().catch(() => null)) as { error?: string } | null)
              : null;
          await dialogs.notify({
            description:
              refusal?.error === "too_many_matches"
                ? tBulk("tooManyToast", { max: MAX_BULK_IDS })
                : tBulk("errorToast"),
            variant: "destructive",
          });
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
        await dialogs.notify({ description: message });
        selection.clear();
        setReloadKey((k) => k + 1);
      } finally {
        setBusy(false);
      }
    },
    [busy, selection, tBulk, dialogs],
  );

  // F-114: approve and block run without a dialog on the rows an admin ticked,
  // but "select all matching" can reach every user in the search, up to the
  // bulk cap, so there they first ask, naming the count. Ban (reason prompt)
  // and soft-delete (confirmation) already ask in both modes.
  const runStatusAction = useCallback(
    async (action: "approve" | "block", label: string) => {
      if (await refuseOverCap()) return;
      if (selection.mode === "all") {
        const ok = await dialogs.confirm({
          title: label,
          description: tBulk("confirmAllMatching", { count: selection.matchingTotal ?? 0 }),
        });
        if (!ok) return;
      }
      await runBulkAction(action);
    },
    [selection, dialogs, tBulk, runBulkAction, refuseOverCap],
  );

  const bulkActions = useMemo<BulkActionDescriptor[]>(
    () => [
      {
        key: "approve",
        label: tBulk("approve"),
        onSelect: () => void runStatusAction("approve", tBulk("approve")),
      },
      {
        key: "block",
        label: tBulk("block"),
        onSelect: () => void runStatusAction("block", tBulk("block")),
      },
      {
        key: "ban",
        label: tBulk("ban"),
        destructive: true,
        onSelect: () => {
          void (async () => {
            if (await refuseOverCap()) return;
            const reason = await dialogs.promptText({
              title: tBulk("ban"),
              label: tBulk("reasonPrompt"),
              required: true,
            });
            if (!reason) return;
            void runBulkAction("ban", { reason });
          })();
        },
      },
      {
        key: "soft_delete",
        label: tBulk("softDelete"),
        destructive: true,
        onSelect: () => {
          void (async () => {
            if (await refuseOverCap()) return;
            const ok = await dialogs.confirm({
              title: tBulk("softDelete"),
              description: tBulk("confirmDelete"),
              destructive: true,
            });
            if (!ok) return;
            void runBulkAction("soft_delete");
          })();
        },
      },
    ],
    [tBulk, runBulkAction, runStatusAction, refuseOverCap, dialogs],
  );

  const filters = useMemo<GridFilterDescriptor[]>(
    () => [
      {
        name: "status",
        label: t("status"),
        options: toFilterOptions(tGrid, APP_USER_STATUS_VALUES),
      },
    ],
    [t, tGrid],
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
      searchable
      filters={filters}
      selection={{ state: selection, getRowId: (row) => row.id }}
      bulkActions={bulkActions}
      exportResource="users"
      headerActions={headerActions}
    />
  );
}
