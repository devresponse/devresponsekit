"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LocaleLink } from "@/components/i18n/locale-link";
import { DataGrid } from "../../_components/grid/data-grid";
import { UserPicker, type UserOption } from "./_user-picker";

/**
 * Members tab for the group detail (ADR-0002). Reuses the shared `DataGrid`;
 * each row's email links into the user-detail page. With `admin.groups.assign`
 * the operator can also add a member (dialog → user picker → POST) and remove
 * one (confirm → DELETE) via `/api/administrator/groups/[id]/members`. The
 * server confines adds to ACTIVE members of the group's org and applies the
 * privilege-escalation guard, so a non-eligible pick is reported back here.
 */
interface MemberRow {
  app_user_id: string;
  primary_email: string;
  display_name: string | null;
  status: string;
  created_at: string;
}

export function GroupMembersGrid({
  groupId,
  canAssign = false,
}: {
  groupId: string;
  canAssign?: boolean;
}) {
  const t = useTranslations("administrator.groups.members");
  const locale = useLocale();
  const dialogs = useDialogs();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<UserOption | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const onRemove = useCallback(
    async (row: MemberRow) => {
      const ok = await dialogs.confirm({
        title: t("removeConfirm"),
        description: row.primary_email,
        destructive: true,
      });
      if (!ok) return;
      setRowError(null);
      const res = await fetch(`/api/administrator/groups/${groupId}/members`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appUserIds: [row.app_user_id] }),
      });
      if (!res.ok) {
        setRowError(t("removeError"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [t, groupId, dialogs],
  );

  const onAdd = useCallback(async () => {
    if (!selected) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/administrator/groups/${groupId}/members`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appUserIds: [selected.id] }),
      });
      if (!res.ok) {
        setAddError(t("addError"));
        return;
      }
      // The endpoint silently drops a user who isn't an ACTIVE member of the
      // group's org (returns `added: 0`); surface that rather than a false ok.
      const body = (await res.json()) as { added?: number };
      if ((body.added ?? 0) === 0) {
        setAddError(t("notEligible"));
        return;
      }
      setAddOpen(false);
      setSelected(null);
      setReloadKey((k) => k + 1);
    } catch {
      setAddError(t("addError"));
    } finally {
      setAdding(false);
    }
  }, [selected, groupId, t]);

  const columns = useMemo<ColumnDef<MemberRow, unknown>[]>(() => {
    const base: ColumnDef<MemberRow, unknown>[] = [
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
    ];
    if (!canAssign) return base;
    return [
      ...base,
      {
        id: "actions",
        enableSorting: false,
        header: () => "",
        cell: ({ row }: { row: { original: MemberRow } }) => (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onRemove(row.original)}
            >
              {t("removeButton")}
            </Button>
          </div>
        ),
      } as ColumnDef<MemberRow, unknown>,
    ];
  }, [t, locale, dateFormatter, canAssign, onRemove]);

  return (
    <div className="space-y-2">
      {rowError ? (
        <p className="text-destructive text-sm" role="alert">
          {rowError}
        </p>
      ) : null}
      <DataGrid<MemberRow>
        key={reloadKey}
        name={`administrator.group-members.${groupId}`}
        endpoint={`/api/administrator/groups/${groupId}/members`}
        columns={columns}
        options={{
          defaultPageSize: 25,
          defaultSort: [{ field: "primary_email", direction: "asc" }],
        }}
        searchable
        headerActions={
          canAssign ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setAddError(null);
                setSelected(null);
                setAddOpen(true);
              }}
            >
              {t("addButton")}
            </Button>
          ) : undefined
        }
      />
      {canAssign ? (
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("dialog.title")}</DialogTitle>
              <DialogDescription>{t("dialog.description")}</DialogDescription>
            </DialogHeader>
            <UserPicker value={selected} onChange={setSelected} />
            {addError ? (
              <p className="text-destructive text-sm" role="alert">
                {addError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddOpen(false)}
                disabled={adding}
              >
                {t("dialog.cancel")}
              </Button>
              <Button type="button" onClick={onAdd} disabled={adding || selected === null}>
                {t("dialog.submit")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
