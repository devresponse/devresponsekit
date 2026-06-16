"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Dual-list ROLES editor for a group (ADR-0002).
 *
 * Left column = roles available in the org (the org's role catalog minus the
 * ones already bundled). Right column = roles the group currently confers.
 * `Save` diffs against the server's known set and dispatches one
 * POST `{ roleIds: toAdd }` and one DELETE `{ roleIds: toRemove }` against
 * `/api/administrator/groups/[id]/roles`. The server rejects a foreign/global
 * role (404) and a `superuser`-granting role for a non-superadmin (403).
 */
interface RoleOption {
  id: string;
  key: string;
  name: string;
}

export function GroupRolesEditor({ groupId, canAssign }: { groupId: string; canAssign: boolean }) {
  const t = useTranslations("administrator.groups.rolesEditor");
  const tErr = useTranslations("administrator.errors");

  const [catalog, setCatalog] = useState<RoleOption[] | null>(null);
  const [assigned, setAssigned] = useState<string[]>([]);
  const [serverAssigned, setServerAssigned] = useState<string[]>([]);
  const [availableSelected, setAvailableSelected] = useState<string[]>([]);
  const [assignedSelected, setAssignedSelected] = useState<string[]>([]);
  const [availableQ, setAvailableQ] = useState("");
  const [assignedQ, setAssignedQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the org's role catalog and the group's currently-assigned roles.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rolesRes, assignedRes] = await Promise.all([
          fetch("/api/administrator/roles?pageSize=200", { credentials: "same-origin" }),
          fetch(`/api/administrator/groups/${groupId}/roles`, { credentials: "same-origin" }),
        ]);
        if (!rolesRes.ok || !assignedRes.ok) {
          if (!cancelled) setError(tErr("generic"));
          return;
        }
        const rolesBody = (await rolesRes.json()) as { items: RoleOption[] };
        const assignedBody = (await assignedRes.json()) as { roles: RoleOption[] };
        if (cancelled) return;
        setCatalog(rolesBody.items);
        const ids = assignedBody.roles.map((r) => r.id).sort();
        setAssigned(ids);
        setServerAssigned(ids);
      } catch {
        if (!cancelled) setError(tErr("generic"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, tErr]);

  const keyById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of catalog ?? []) m.set(r.id, r.key);
    return m;
  }, [catalog]);

  const assignedSet = useMemo(() => new Set(assigned), [assigned]);

  const availableFiltered = useMemo(() => {
    if (!catalog) return [];
    const q = availableQ.trim().toLowerCase();
    return catalog
      .filter((r) => !assignedSet.has(r.id))
      .filter((r) => (q ? r.key.toLowerCase().includes(q) : true));
  }, [catalog, assignedSet, availableQ]);

  const assignedFiltered = useMemo(() => {
    const q = assignedQ.trim().toLowerCase();
    return assigned.filter((id) => {
      const k = keyById.get(id) ?? id;
      return q ? k.toLowerCase().includes(q) : true;
    });
  }, [assigned, assignedQ, keyById]);

  const diff = useMemo(() => {
    const cur = new Set(serverAssigned);
    const nxt = new Set(assigned);
    return {
      toAdd: assigned.filter((id) => !cur.has(id)),
      toRemove: serverAssigned.filter((id) => !nxt.has(id)),
    };
  }, [serverAssigned, assigned]);
  const dirty = diff.toAdd.length > 0 || diff.toRemove.length > 0;

  const moveToAssigned = useCallback(() => {
    setError(null);
    setInfo(null);
    setAssigned((prev) => Array.from(new Set([...prev, ...availableSelected])).sort());
    setAvailableSelected([]);
  }, [availableSelected]);

  const moveToAvailable = useCallback(() => {
    setError(null);
    setInfo(null);
    setAssigned((prev) => prev.filter((id) => !assignedSelected.includes(id)));
    setAssignedSelected([]);
  }, [assignedSelected]);

  const onSave = useCallback(async () => {
    setError(null);
    setInfo(null);
    setSaving(true);
    try {
      if (diff.toAdd.length > 0) {
        const res = await fetch(`/api/administrator/groups/${groupId}/roles`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roleIds: diff.toAdd }),
        });
        if (!res.ok) {
          setError(res.status === 403 ? tErr("forbidden") : t("errorToast"));
          return;
        }
      }
      if (diff.toRemove.length > 0) {
        const res = await fetch(`/api/administrator/groups/${groupId}/roles`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roleIds: diff.toRemove }),
        });
        if (!res.ok) {
          setError(t("errorToast"));
          return;
        }
      }
      const fresh = await fetch(`/api/administrator/groups/${groupId}/roles`, {
        credentials: "same-origin",
      });
      if (fresh.ok) {
        const body = (await fresh.json()) as { roles: RoleOption[] };
        const ids = body.roles.map((r) => r.id).sort();
        setAssigned(ids);
        setServerAssigned(ids);
      } else {
        setServerAssigned([...assigned].sort());
      }
      setInfo(t("saved"));
    } catch {
      setError(t("errorToast"));
    } finally {
      setSaving(false);
    }
  }, [groupId, diff, assigned, t, tErr]);

  if (!catalog) {
    // A failed initial load sets `error` but leaves the catalog null; surface
    // the message here rather than spinning the skeleton forever.
    return (
      <div className="space-y-2">
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : (
          <>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-48 w-full" />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="text-success text-sm" role="status">
          {info}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Column
          titleKey="available"
          searchKey="searchAvailable"
          options={availableFiltered.map((r) => ({ id: r.id, label: r.key }))}
          selected={availableSelected}
          onSelectedChange={setAvailableSelected}
          q={availableQ}
          onQChange={setAvailableQ}
          disabled={!canAssign}
        />
        <Column
          titleKey="assigned"
          searchKey="searchAssigned"
          options={assignedFiltered.map((id) => ({ id, label: keyById.get(id) ?? id }))}
          selected={assignedSelected}
          onSelectedChange={setAssignedSelected}
          q={assignedQ}
          onQChange={setAssignedQ}
          disabled={!canAssign}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={moveToAssigned}
          disabled={!canAssign || availableSelected.length === 0}
        >
          {t("add")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={moveToAvailable}
          disabled={!canAssign || assignedSelected.length === 0}
        >
          {t("remove")}
        </Button>
        <div className="flex-1" />
        <Button type="button" size="sm" onClick={onSave} disabled={!canAssign || saving || !dirty}>
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  );
}

function Column({
  titleKey,
  searchKey,
  options,
  selected,
  onSelectedChange,
  q,
  onQChange,
  disabled,
}: {
  titleKey: "available" | "assigned";
  searchKey: "searchAvailable" | "searchAssigned";
  options: ReadonlyArray<{ id: string; label: string }>;
  selected: string[];
  onSelectedChange(next: string[]): void;
  q: string;
  onQChange(next: string): void;
  disabled: boolean;
}) {
  const t = useTranslations("administrator.groups.rolesEditor");
  const listId = `group-roles-${titleKey}`;
  const inputId = `group-roles-search-${titleKey}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId} className="text-sm font-semibold">
        {t(titleKey)} ({options.length})
      </Label>
      <Input
        id={inputId}
        type="search"
        placeholder={t(searchKey)}
        value={q}
        onChange={(e) => onQChange(e.currentTarget.value)}
      />
      <select
        id={listId}
        multiple
        size={10}
        className="border-input bg-background h-64 w-full rounded-md border px-2 py-1 text-sm"
        value={selected}
        onChange={(e) =>
          onSelectedChange(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))
        }
        disabled={disabled}
      >
        {options.length === 0 ? (
          <option disabled value="">
            {t("noResults")}
          </option>
        ) : (
          options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
