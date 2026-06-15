"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DataGrid } from "../_components/grid/data-grid";
import { useGridState } from "../_components/grid/use-grid-state";

/**
 * Client-side audit explorer (docs/admin-manager.md §8.11, Phase 6).
 *
 * Read-only paginated grid over `app_audit_events`. Filters are kept
 * narrow on purpose — the spec lists `event_type`, `outcome`, `actor`,
 * `app_user_id`, `organization_id`, `target_application_id`, and a
 * created_at range. Each row opens a `Sheet` with the full JSON
 * `metadata`, IP, user agent, and reason.
 *
 * Performance:
 *   - Default sort `created_at desc` matches the
 *     `idx_app_audit_events_created_at_desc` index from `0001-initial-schema.sql`.
 *   - Default page size 50 (vs. the 25 used elsewhere) — admins typically
 *     scan audit history in larger windows.
 *
 * Security:
 *   - The grid renders metadata as a JSON string. We never execute any
 *     value from `metadata`; it's surfaced as text only.
 */
interface AuditRow {
  id: string;
  event_type: string;
  outcome: string;
  actor_better_auth_user_id: string | null;
  app_user_id: string | null;
  organization_id: string | null;
  target_application_id: string | null;
  provider: string | null;
  email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  reason: string | null;
  metadata: unknown;
  created_at: string;
}

export function AdministratorAuditGrid() {
  const t = useTranslations("administrator.audit");
  const intlLocale = useLocale();

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [intlLocale],
  );

  const [openRow, setOpenRow] = useState<AuditRow | null>(null);

  const columns = useMemo<ColumnDef<AuditRow, unknown>[]>(
    () => [
      {
        id: "created_at",
        accessorKey: "created_at",
        header: () => t("columns.createdAt"),
        cell: ({ row }) => {
          const d = new Date(row.original.created_at);
          return (
            <span className="text-xs whitespace-nowrap">
              {Number.isNaN(d.getTime()) ? row.original.created_at : dateFormatter.format(d)}
            </span>
          );
        },
      },
      {
        id: "event_type",
        accessorKey: "event_type",
        header: () => t("columns.eventType"),
        cell: ({ row }) => <code className="text-xs">{row.original.event_type}</code>,
      },
      {
        id: "outcome",
        accessorKey: "outcome",
        header: () => t("columns.outcome"),
        cell: ({ row }) => (
          <Badge variant={outcomeVariant(row.original.outcome)}>{row.original.outcome}</Badge>
        ),
      },
      {
        id: "actor",
        accessorKey: "actor_better_auth_user_id",
        header: () => t("columns.actor"),
        cell: ({ row }) =>
          row.original.actor_better_auth_user_id ? (
            <code className="text-xs">{row.original.actor_better_auth_user_id}</code>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "target",
        enableSorting: false,
        header: () => t("columns.target"),
        cell: ({ row }) => {
          const parts: string[] = [];
          if (row.original.app_user_id) parts.push(`user:${row.original.app_user_id}`);
          if (row.original.organization_id) parts.push(`org:${row.original.organization_id}`);
          if (row.original.target_application_id)
            parts.push(`app:${row.original.target_application_id}`);
          return parts.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="space-y-1 text-xs">
              {parts.map((p) => (
                <code key={p} className="block">
                  {p}
                </code>
              ))}
            </span>
          );
        },
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => "",
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOpenRow(row.original)}
            >
              {t("viewDetail")}
            </Button>
          </div>
        ),
      },
    ],
    [t, dateFormatter],
  );

  return (
    <div className="space-y-3">
      <AuditFilterToolbar />
      <DataGrid<AuditRow>
        name="administrator.audit"
        endpoint="/api/administrator/audit"
        columns={columns}
        options={{
          defaultPageSize: 50,
          defaultSort: [{ field: "created_at", direction: "desc" }],
        }}
      />
      <Sheet open={openRow !== null} onOpenChange={(open) => !open && setOpenRow(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          {openRow ? <AuditDetail row={openRow} t={t} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function outcomeVariant(outcome: string): "default" | "destructive" | "secondary" | "outline" {
  if (outcome === "success") return "secondary";
  // Treat the deprecated `failure` value the same as the new `error`
  // value (docs/admin-manager.md §12) so historical rows keep
  // rendering correctly.
  if (outcome === "failure" || outcome === "error") return "destructive";
  if (outcome === "denied") return "destructive";
  return "outline";
}

/**
 * Inline filter toolbar — the audit explorer is the only Phase-6 grid
 * with an exposed filter UI. Filters write directly to URL state so a
 * shared link reproduces the same view (§10).
 */
function AuditFilterToolbar() {
  const t = useTranslations("administrator.audit");
  const { state, setFilter } = useGridState({
    defaultPageSize: 50,
    defaultSort: [{ field: "created_at", direction: "desc" }],
  });

  const eventType = (state.filters.event_type as string | undefined) ?? "";
  const outcome = (state.filters.outcome as string | undefined) ?? "";
  const actor = (state.filters.actor as string | undefined) ?? "";

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor="audit-event-type" className="text-xs">
          {t("filters.eventType")}
        </Label>
        <Input
          id="audit-event-type"
          type="text"
          value={eventType}
          onChange={(e) => setFilter("event_type", e.currentTarget.value || null)}
          placeholder="admin.user.banned"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="audit-outcome" className="text-xs">
          {t("filters.outcome")}
        </Label>
        <select
          id="audit-outcome"
          value={outcome}
          onChange={(e) => setFilter("outcome", e.currentTarget.value || null)}
          className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
        >
          <option value="">{t("filters.any")}</option>
          <option value="success">{t("outcome.success")}</option>
          <option value="error">{t("outcome.error")}</option>
          <option value="denied">{t("outcome.denied")}</option>
          <option value="failure">{t("outcome.failure")}</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="audit-actor" className="text-xs">
          {t("filters.actor")}
        </Label>
        <Input
          id="audit-actor"
          type="text"
          value={actor}
          onChange={(e) => setFilter("actor", e.currentTarget.value || null)}
          placeholder={t("filters.actorPlaceholder")}
        />
      </div>
    </div>
  );
}

function AuditDetail({
  row,
  t,
}: {
  row: AuditRow;
  t: ReturnType<typeof useTranslations<"administrator.audit">>;
}) {
  const metadataString = useMemo(() => {
    try {
      return JSON.stringify(row.metadata ?? {}, null, 2);
    } catch {
      return String(row.metadata);
    }
  }, [row.metadata]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <SheetHeader>
        <SheetTitle>
          <code className="text-xs">{row.event_type}</code>
        </SheetTitle>
        <SheetDescription>
          {row.created_at} · {row.outcome}
        </SheetDescription>
      </SheetHeader>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
        <Field label={t("detail.actor")}>{row.actor_better_auth_user_id ?? "—"}</Field>
        <Field label={t("detail.appUser")}>{row.app_user_id ?? "—"}</Field>
        <Field label={t("detail.organization")}>{row.organization_id ?? "—"}</Field>
        <Field label={t("detail.targetApplication")}>{row.target_application_id ?? "—"}</Field>
        <Field label={t("detail.provider")}>{row.provider ?? "—"}</Field>
        <Field label={t("detail.email")}>{row.email ?? "—"}</Field>
        <Field label={t("detail.ipAddress")}>{row.ip_address ?? "—"}</Field>
        <Field label={t("detail.userAgent")}>
          <span className="break-all">{row.user_agent ?? "—"}</span>
        </Field>
        <Field label={t("detail.reason")}>{row.reason ?? "—"}</Field>
      </dl>
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">{t("detail.metadata")}</h4>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{metadataString}</pre>
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
