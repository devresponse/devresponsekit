"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDialogs } from "@/components/ui/dialog-manager";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GroupPicker, type GroupOption } from "./_group-picker";

/**
 * Groups tab for the user detail (docs/admin-manager.md §8.4, ADR-0002).
 *
 * Lists the groups the user belongs to (`GET …/users/[id]/groups`, scoped to
 * the caller's org). With `admin.groups.assign` the operator can add the user
 * to a group (dialog → picker → POST) or remove them (confirm → DELETE) via
 * `…/users/[id]/groups`. Group membership confers the union of the group's
 * roles' permissions (ADR-0002), so the server applies the privilege guards.
 *
 * Fetch-list pattern mirrors `_user-sessions-panel.tsx`; the assign dialog
 * mirrors `_user-roles-panel.tsx`.
 */
interface GroupRow {
  id: string;
  organization_id: string;
  key: string;
  name: string;
}

export function UserGroupsPanel({
  userId,
  canManage = false,
}: {
  userId: string;
  canManage?: boolean;
}) {
  const t = useTranslations("administrator.users.groups");
  const dialogs = useDialogs();

  const [groups, setGroups] = useState<GroupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<GroupOption | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/administrator/users/${userId}/groups`, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`http_${res.status}`);
        return (await res.json()) as { groups?: GroupRow[] };
      })
      .then((body) => {
        if (cancelled) return;
        setGroups(body.groups ?? []);
        setBusy(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t("loadError"));
        setGroups([]);
        setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, t, reloadToken]);

  const onRemove = async (group: GroupRow) => {
    const ok = await dialogs.confirm({
      title: t("removeConfirm"),
      description: group.name,
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/administrator/users/${userId}/groups`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupId: group.id }),
      });
      if (!res.ok) setError(t("removeError"));
    } catch {
      setError(t("removeError"));
    }
    setReloadToken((n) => n + 1);
  };

  const onAdd = async () => {
    if (!selected) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/administrator/users/${userId}/groups`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupId: selected.id }),
      });
      if (!res.ok) {
        setAddError(t("addError"));
        return;
      }
      setAddOpen(false);
      setSelected(null);
      setReloadToken((n) => n + 1);
    } catch {
      setAddError(t("addError"));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        {canManage ? (
          <Button
            size="sm"
            onClick={() => {
              setAddError(null);
              setSelected(null);
              setAddOpen(true);
            }}
          >
            {t("addButton")}
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {groups === null ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {groups.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0 space-y-0.5">
                <p className="truncate font-medium">{g.name}</p>
                <code className="text-muted-foreground text-xs">{g.key}</code>
              </div>
              {canManage ? (
                <Button size="sm" variant="outline" onClick={() => onRemove(g)} disabled={busy}>
                  {t("removeButton")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("dialog.title")}</DialogTitle>
              <DialogDescription>{t("dialog.description")}</DialogDescription>
            </DialogHeader>
            <GroupPicker
              value={selected}
              onChange={setSelected}
              excludeIds={groups?.map((g) => g.id) ?? []}
            />
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
