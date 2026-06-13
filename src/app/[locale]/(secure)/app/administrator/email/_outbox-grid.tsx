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
 * Client-side outbox explorer (specs.md §35), following the audit-grid
 * pattern: read-only paginated grid, URL-backed filters, per-row detail
 * Sheet. The detail view renders email bodies as TEXT (never
 * `dangerouslySetInnerHTML`) — templates are admin-editable, and the
 * outbox must not become an HTML injection vector into an admin's
 * browser.
 */
interface OutboxRow {
  id: string;
  template_key: string | null;
  to_email: string;
  from_email: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  error: string | null;
  related_better_auth_user_id: string | null;
  created_at: string;
  sent_at: string | null;
}

export function AdministratorOutboxGrid({ canManage }: { canManage: boolean }) {
  const t = useTranslations("administrator.email");
  const intlLocale = useLocale();

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [intlLocale],
  );

  const [openRow, setOpenRow] = useState<OutboxRow | null>(null);
  // Remounting the grid is the simplest reliable refetch after a test
  // send lands a new outbox row.
  const [gridEpoch, setGridEpoch] = useState(0);

  const columns = useMemo<ColumnDef<OutboxRow, unknown>[]>(
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
        id: "to_email",
        accessorKey: "to_email",
        header: () => t("columns.to"),
        cell: ({ row }) => <span className="text-xs">{row.original.to_email}</span>,
      },
      {
        id: "subject",
        enableSorting: false,
        header: () => t("columns.subject"),
        cell: ({ row }) => <span className="text-xs">{row.original.subject}</span>,
      },
      {
        id: "template_key",
        accessorKey: "template_key",
        header: () => t("columns.template"),
        cell: ({ row }) =>
          row.original.template_key ? (
            <code className="text-xs">{row.original.template_key}</code>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        cell: ({ row }) => (
          <Badge variant={statusVariant(row.original.status)}>
            {t(`status.${row.original.status}` as Parameters<typeof t>[0])}
          </Badge>
        ),
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
      <OutboxFilterToolbar />
      <DataGrid<OutboxRow>
        key={gridEpoch}
        name="administrator.email.outbox"
        endpoint="/api/administrator/email/outbox"
        columns={columns}
        options={{
          defaultPageSize: 50,
          defaultSort: [{ field: "created_at", direction: "desc" }],
        }}
        headerActions={
          canManage ? <SendTestEmail onSent={() => setGridEpoch((n) => n + 1)} /> : undefined
        }
      />
      <Sheet open={openRow !== null} onOpenChange={(open) => !open && setOpenRow(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          {openRow ? <OutboxDetail row={openRow} t={t} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function statusVariant(status: string): "default" | "destructive" | "secondary" | "outline" {
  if (status === "sent") return "secondary";
  if (status === "failed") return "destructive";
  return "outline";
}

function OutboxFilterToolbar() {
  const t = useTranslations("administrator.email");
  const { state, setFilter } = useGridState({
    defaultPageSize: 50,
    defaultSort: [{ field: "created_at", direction: "desc" }],
  });

  const status = (state.filters.status as string | undefined) ?? "";
  const templateKey = (state.filters.template_key as string | undefined) ?? "";

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor="outbox-status" className="text-xs">
          {t("filters.status")}
        </Label>
        <select
          id="outbox-status"
          value={status}
          onChange={(e) => setFilter("status", e.currentTarget.value || null)}
          className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
        >
          <option value="">{t("filters.any")}</option>
          <option value="sent">{t("status.sent")}</option>
          <option value="failed">{t("status.failed")}</option>
          <option value="logged">{t("status.logged")}</option>
          <option value="pending">{t("status.pending")}</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="outbox-template" className="text-xs">
          {t("filters.template")}
        </Label>
        <Input
          id="outbox-template"
          type="text"
          value={templateKey}
          onChange={(e) => setFilter("template_key", e.currentTarget.value || null)}
          placeholder="password_reset"
        />
      </div>
    </div>
  );
}

/**
 * Toolbar action: sends the `test_email` template through the full
 * outbox pipeline — the canonical way to verify provider configuration
 * (or, with no provider, the rendering + outbox wiring itself).
 */
function SendTestEmail({ onSent }: { onSent: () => void }) {
  const t = useTranslations("administrator.email");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/administrator/email/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: to.trim() }),
      });
      if (!res.ok) {
        setResult(t("test.error"));
        return;
      }
      const body = (await res.json()) as { status: string };
      setResult(t(`test.result.${body.status}` as Parameters<typeof t>[0]));
      setTo("");
      onSent();
    } catch {
      setResult(t("test.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {result ? <span className="text-muted-foreground text-xs">{result}</span> : null}
      <Input
        type="email"
        value={to}
        onChange={(e) => setTo(e.currentTarget.value)}
        placeholder={t("test.placeholder")}
        aria-label={t("test.placeholder")}
        className="h-8 w-56"
      />
      <Button type="button" size="sm" disabled={busy || to.trim().length === 0} onClick={send}>
        {t("test.send")}
      </Button>
    </div>
  );
}

function OutboxDetail({
  row,
  t,
}: {
  row: OutboxRow;
  t: ReturnType<typeof useTranslations<"administrator.email">>;
}) {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <SheetHeader>
        <SheetTitle>{row.subject}</SheetTitle>
        <SheetDescription>
          {row.to_email} · {t(`status.${row.status}` as Parameters<typeof t>[0])}
        </SheetDescription>
      </SheetHeader>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
        <Field label={t("detail.from")}>{row.from_email}</Field>
        <Field label={t("detail.to")}>{row.to_email}</Field>
        <Field label={t("detail.template")}>{row.template_key ?? "—"}</Field>
        <Field label={t("detail.provider")}>{row.provider ?? "—"}</Field>
        <Field label={t("detail.providerMessageId")}>{row.provider_message_id ?? "—"}</Field>
        <Field label={t("detail.createdAt")}>{row.created_at}</Field>
        <Field label={t("detail.sentAt")}>{row.sent_at ?? "—"}</Field>
        <Field label={t("detail.relatedUser")}>{row.related_better_auth_user_id ?? "—"}</Field>
        {row.error ? <Field label={t("detail.error")}>{row.error}</Field> : null}
      </dl>
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">{t("detail.bodyText")}</h4>
        <pre className="bg-muted rounded-md p-3 text-xs whitespace-pre-wrap">
          {row.body_text ?? "—"}
        </pre>
      </div>
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">{t("detail.bodyHtml")}</h4>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
          {row.body_html}
        </pre>
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
