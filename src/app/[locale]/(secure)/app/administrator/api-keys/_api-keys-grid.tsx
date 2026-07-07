"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useDialogs } from "@/components/ui/dialog-manager";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../_components/grid/data-grid";
import { toFilterOptions, type GridFilterDescriptor } from "../_components/grid/data-grid-filters";
import { ApiKeyRevealDialog } from "@/components/api-keys/api-key-reveal";

/** API-key statuses — the allow-listed `status` filter values. */
const API_KEY_STATUSES = ["active", "revoked"] as const;

/**
 * Client-side API-key governance grid (docs/admin-manager.md §8.8).
 *
 * Read-only admins (`admin.apikeys.read`) get the full inventory with a
 * status + owner filter toolbar and a per-row detail `Sheet`. Admins
 * who also hold `admin.apikeys.manage` get inline Rotate / Revoke
 * actions. Mutations re-fetch by bumping `reloadKey` (re-mounting the
 * inner `DataGrid`), matching the enterprise-apps grid.
 *
 * Secrets are never present in list data; rotation surfaces the new
 * plaintext exactly once through {@link ApiKeyRevealDialog}.
 */
interface ApiKeyRow {
  id: string;
  app_user_id: string;
  owner_email: string | null;
  owner_name: string | null;
  organization_id: string | null;
  name: string;
  key_prefix: string;
  scopes: string[];
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export function AdministratorApiKeysGrid({
  locale,
  canManage,
  headerActions,
}: {
  locale: string;
  canManage: boolean;
  headerActions?: ReactNode;
}) {
  const t = useTranslations("administrator.apiKeys");
  const tGrid = useTranslations("administrator.grid");
  const intlLocale = useLocale();
  const dialogs = useDialogs();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium", timeStyle: "short" }),
    [intlLocale],
  );

  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  const onRevoke = useCallback(
    async (id: string, name: string) => {
      const ok = await dialogs.confirm({
        title: t("dialogs.revoke.title"),
        description: t("dialogs.revoke.description") + "\n\n" + name,
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/api-keys/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setRowError(t("revokeError"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [dialogs, t],
  );

  const onRotate = useCallback(
    async (id: string, name: string) => {
      const ok = await dialogs.confirm({
        title: t("dialogs.rotate.title"),
        description: t("dialogs.rotate.description") + "\n\n" + name,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/api-keys/${encodeURIComponent(id)}/rotate`, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        setRowError(t("rotateError"));
        return;
      }
      const body = (await res.json().catch(() => null)) as { key?: string } | null;
      setReloadKey((k) => k + 1);
      if (body?.key) setRevealed(body.key);
      else setRowError(t("rotateError"));
    },
    [dialogs, t],
  );

  const columns = useMemo<ColumnDef<ApiKeyRow, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: () => t("columns.name"),
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setDetailId(row.original.id)}
            className="text-primary text-left underline-offset-4 hover:underline"
          >
            {row.original.name}
          </button>
        ),
      },
      {
        id: "key_prefix",
        enableSorting: false,
        header: () => t("columns.prefix"),
        cell: ({ row }) => <code className="text-xs">{row.original.key_prefix}…</code>,
      },
      {
        id: "owner",
        enableSorting: false,
        header: () => t("columns.owner"),
        cell: ({ row }) =>
          row.original.owner_email ? (
            <LocaleLink
              locale={locale}
              href={`/app/administrator/users/${row.original.app_user_id}`}
              className="text-primary text-xs underline-offset-4 hover:underline"
            >
              {row.original.owner_email}
            </LocaleLink>
          ) : (
            <span className="text-muted-foreground text-xs">{row.original.app_user_id}</span>
          ),
      },
      {
        id: "scopes",
        enableSorting: false,
        header: () => t("columns.scopes"),
        cell: ({ row }) => (
          <Badge variant="outline" title={row.original.scopes.join(" ")}>
            {t("scopeCount", { count: row.original.scopes.length })}
          </Badge>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        cell: ({ row }) => (
          <StatusBadge status={row.original.status} label={t(`status.${row.original.status}`)} />
        ),
      },
      {
        id: "last_used_at",
        accessorKey: "last_used_at",
        header: () => t("columns.lastUsed"),
        cell: ({ row }) => formatDate(row.original.last_used_at, dateFormatter, t("never")),
      },
      {
        id: "expires_at",
        accessorKey: "expires_at",
        header: () => t("columns.expires"),
        cell: ({ row }) => formatDate(row.original.expires_at, dateFormatter, t("noExpiry")),
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.created"),
        cell: ({ row }) => formatDate(row.original.created_at, dateFormatter, "—"),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => "",
        cell: ({ row }) => (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDetailId(row.original.id)}
            >
              {t("actions.view")}
            </Button>
            {canManage && row.original.status === "active" ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onRotate(row.original.id, row.original.name)}
                >
                  {t("actions.rotate")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onRevoke(row.original.id, row.original.name)}
                >
                  {t("actions.revoke")}
                </Button>
              </>
            ) : null}
          </div>
        ),
      },
    ],
    [t, locale, dateFormatter, canManage, onRotate, onRevoke],
  );

  const filters = useMemo<GridFilterDescriptor[]>(
    () => [
      {
        name: "status",
        label: t("filters.status"),
        options: toFilterOptions(tGrid, API_KEY_STATUSES),
      },
    ],
    [t, tGrid],
  );

  return (
    <div className="space-y-3">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<ApiKeyRow>
        key={reloadKey}
        name="administrator.apiKeys"
        endpoint="/api/administrator/api-keys"
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "created_at", direction: "desc" }],
        }}
        searchable
        searchPlaceholder={t("filters.searchPlaceholder")}
        filters={filters}
        headerActions={headerActions}
      />
      <Sheet open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          {detailId ? (
            <ApiKeyDetail key={detailId} id={detailId} t={t} dateFormatter={dateFormatter} />
          ) : null}
        </SheetContent>
      </Sheet>
      <ApiKeyRevealDialog
        secret={revealed}
        onClose={() => setRevealed(null)}
        namespace="administrator.apiKeys.reveal"
      />
    </div>
  );
}

interface ApiKeyDetailData {
  id: string;
  app_user_id: string;
  owner_email: string | null;
  owner_name: string | null;
  organization_id: string | null;
  name: string;
  key_prefix: string;
  scopes: string[];
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  created_at: string;
  created_by_email: string | null;
  revoked_at: string | null;
  revoked_by_email: string | null;
  revoked_reason: string | null;
}

function ApiKeyDetail({
  id,
  t,
  dateFormatter,
}: {
  id: string;
  t: ReturnType<typeof useTranslations<"administrator.apiKeys">>;
  dateFormatter: Intl.DateTimeFormat;
}) {
  // Fresh instance per key id (the caller passes `key={id}`), so initial
  // state is already null/false — the effect only writes from its async
  // callbacks, never synchronously.
  const [data, setData] = useState<ApiKeyDetailData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/administrator/api-keys/${encodeURIComponent(id)}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      credentials: "same-origin",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`http_${res.status}`);
        return (await res.json()) as ApiKeyDetailData;
      })
      .then(setData)
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(true);
      });
    return () => controller.abort();
  }, [id]);

  if (error) {
    return (
      <div className="p-2">
        <p className="text-destructive text-sm" role="alert">
          {t("detail.loadError")}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-2">
        <p className="text-muted-foreground text-sm">{t("detail.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <SheetHeader>
        <SheetTitle>{data.name}</SheetTitle>
        <SheetDescription>
          <code className="text-xs">{data.key_prefix}…</code>
        </SheetDescription>
      </SheetHeader>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
        <Field label={t("detail.status")}>
          <StatusBadge status={data.status} label={t(`status.${data.status}`)} />
        </Field>
        <Field label={t("detail.owner")}>{data.owner_email ?? data.app_user_id}</Field>
        <Field label={t("detail.organization")}>{data.organization_id ?? "—"}</Field>
        <Field label={t("detail.created")}>{formatDate(data.created_at, dateFormatter, "—")}</Field>
        <Field label={t("detail.createdBy")}>{data.created_by_email ?? "—"}</Field>
        <Field label={t("detail.lastUsed")}>
          {formatDate(data.last_used_at, dateFormatter, t("never"))}
        </Field>
        <Field label={t("detail.lastUsedIp")}>{data.last_used_ip ?? "—"}</Field>
        <Field label={t("detail.expires")}>
          {formatDate(data.expires_at, dateFormatter, t("noExpiry"))}
        </Field>
        {data.status !== "active" ? (
          <>
            <Field label={t("detail.revoked")}>
              {formatDate(data.revoked_at, dateFormatter, "—")}
            </Field>
            <Field label={t("detail.revokedBy")}>{data.revoked_by_email ?? "—"}</Field>
            <Field label={t("detail.revokedReason")}>{data.revoked_reason ?? "—"}</Field>
          </>
        ) : null}
      </dl>
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">{t("detail.scopes")}</h4>
        {data.scopes.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("detail.noScopes")}</p>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {data.scopes.map((s) => (
              <li key={s}>
                <Badge variant="outline" className="font-mono text-xs">
                  {s}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground col-span-1 text-xs font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="col-span-2 text-sm break-all">{children}</dd>
    </>
  );
}

function formatDate(
  value: string | null,
  formatter: Intl.DateTimeFormat,
  fallback: string,
): string {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatter.format(d);
}
