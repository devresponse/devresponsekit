"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { diffPermissions } from "@/lib/admin/roles.client";

/**
 * Dual-list permissions editor (docs/admin-manager.md §8.6).
 *
 * Left column = available permissions (full catalog minus assigned).
 * Right column = currently assigned. Multi-select on either side; the
 * `Add` / `Remove` buttons move the selected keys between columns.
 *
 * `Save` computes a diff against the server's known set and dispatches
 * one POST `{ ids: toAdd }` and one DELETE `{ ids: toRemove }` against
 * `/api/administrator/roles/[id]/permissions`. We keep both calls
 * sequential (POST then DELETE) so the audit metadata reflects the
 * editor's logical sequence; either failing surfaces an inline error
 * and aborts further work.
 *
 * Search inputs filter each column independently. Results show a count
 * indicator so the operator knows the filter is active.
 */
interface CatalogRow {
  id: string;
  key: string;
  description: string | null;
  used_by_role_count: number;
}

export function RolePermissionsEditor({
  roleId,
  initialAssigned,
  canUpdate,
}: {
  roleId: string;
  initialAssigned: ReadonlyArray<string>;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.roles.permissionsEditor");
  const tErr = useTranslations("administrator.errors");

  const [catalog, setCatalog] = useState<CatalogRow[] | null>(null);
  const [assigned, setAssigned] = useState<string[]>([...initialAssigned].sort());
  const [serverAssigned, setServerAssigned] = useState<string[]>([...initialAssigned].sort());

  const [availableSelected, setAvailableSelected] = useState<string[]>([]);
  const [assignedSelected, setAssignedSelected] = useState<string[]>([]);
  const [availableQ, setAvailableQ] = useState("");
  const [assignedQ, setAssignedQ] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Initial catalog load. We page through everything (capped at 200 by
  // the server). The catalog is small enough that doing this once is
  // cheaper than per-keystroke server-side search.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/administrator/permissions?pageSize=200", {
          credentials: "same-origin",
        });
        if (!res.ok) {
          setError(tErr("generic"));
          return;
        }
        const body = (await res.json()) as { items: CatalogRow[] };
        if (!cancelled) setCatalog(body.items);
      } catch {
        if (!cancelled) setError(tErr("generic"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tErr]);

  const assignedSet = useMemo(() => new Set(assigned), [assigned]);

  const availableFiltered = useMemo(() => {
    if (!catalog) return [];
    const q = availableQ.trim().toLowerCase();
    return catalog
      .filter((p) => !assignedSet.has(p.key))
      .filter((p) => (q ? p.key.toLowerCase().includes(q) : true));
  }, [catalog, assignedSet, availableQ]);

  const assignedFiltered = useMemo(() => {
    const q = assignedQ.trim().toLowerCase();
    return assigned.filter((k) => (q ? k.toLowerCase().includes(q) : true));
  }, [assigned, assignedQ]);

  const dirty = useMemo(() => {
    const { toAdd, toRemove } = diffPermissions(serverAssigned, assigned);
    return toAdd.length > 0 || toRemove.length > 0;
  }, [serverAssigned, assigned]);

  const moveToAssigned = useCallback(() => {
    setError(null);
    setInfo(null);
    setAssigned((prev) => Array.from(new Set([...prev, ...availableSelected])).sort());
    setAvailableSelected([]);
  }, [availableSelected]);

  const moveToAvailable = useCallback(() => {
    setError(null);
    setInfo(null);
    setAssigned((prev) => prev.filter((k) => !assignedSelected.includes(k)));
    setAssignedSelected([]);
  }, [assignedSelected]);

  const onSave = useCallback(async () => {
    setError(null);
    setInfo(null);
    setSaving(true);
    try {
      const { toAdd, toRemove } = diffPermissions(serverAssigned, assigned);
      if (toAdd.length === 0 && toRemove.length === 0) {
        setSaving(false);
        return;
      }
      if (toAdd.length > 0) {
        const res = await fetch(`/api/administrator/roles/${roleId}/permissions`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: toAdd }),
        });
        if (!res.ok) {
          setError(t("errorToast"));
          return;
        }
      }
      if (toRemove.length > 0) {
        const res = await fetch(`/api/administrator/roles/${roleId}/permissions`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: toRemove }),
        });
        if (!res.ok) {
          setError(t("errorToast"));
          return;
        }
      }
      // Re-sync against the server's reported set (the POST/DELETE
      // responses both echo the resulting permission list).
      const fresh = await fetch(`/api/administrator/roles/${roleId}/permissions`, {
        credentials: "same-origin",
      });
      if (fresh.ok) {
        const body = (await fresh.json()) as { permissions: string[] };
        const sorted = [...body.permissions].sort();
        setAssigned(sorted);
        setServerAssigned(sorted);
      } else {
        setServerAssigned([...assigned].sort());
      }
      setInfo(t("saved"));
    } catch {
      setError(t("errorToast"));
    } finally {
      setSaving(false);
    }
  }, [roleId, serverAssigned, assigned, t]);

  if (!catalog) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="text-sm text-green-700" role="status">
          {info}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DualListColumn
          titleKey="available"
          searchKey="searchAvailable"
          items={availableFiltered.map((p) => p.key)}
          selected={availableSelected}
          onSelectedChange={setAvailableSelected}
          q={availableQ}
          onQChange={setAvailableQ}
          disabled={!canUpdate}
        />
        <DualListColumn
          titleKey="assigned"
          searchKey="searchAssigned"
          items={assignedFiltered}
          selected={assignedSelected}
          onSelectedChange={setAssignedSelected}
          q={assignedQ}
          onQChange={setAssignedQ}
          disabled={!canUpdate}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={moveToAssigned}
          disabled={!canUpdate || availableSelected.length === 0}
        >
          {t("add")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={moveToAvailable}
          disabled={!canUpdate || assignedSelected.length === 0}
        >
          {t("remove")}
        </Button>
        <div className="flex-1" />
        <Button type="button" size="sm" onClick={onSave} disabled={!canUpdate || saving || !dirty}>
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  );
}

function DualListColumn({
  titleKey,
  searchKey,
  items,
  selected,
  onSelectedChange,
  q,
  onQChange,
  disabled,
}: {
  titleKey: "available" | "assigned";
  searchKey: "searchAvailable" | "searchAssigned";
  items: string[];
  selected: string[];
  onSelectedChange(next: string[]): void;
  q: string;
  onQChange(next: string): void;
  disabled: boolean;
}) {
  const t = useTranslations("administrator.roles.permissionsEditor");
  const id = `permissions-list-${titleKey}`;
  const inputId = `permissions-search-${titleKey}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId} className="text-sm font-semibold">
        {t(titleKey)} ({items.length})
      </Label>
      <Input
        id={inputId}
        type="search"
        placeholder={t(searchKey)}
        value={q}
        onChange={(e) => onQChange(e.currentTarget.value)}
      />
      <select
        id={id}
        multiple
        size={10}
        className="border-input bg-background h-64 w-full rounded-md border px-2 py-1 text-sm"
        value={selected}
        onChange={(e) => {
          const next = Array.from(e.currentTarget.selectedOptions).map((o) => o.value);
          onSelectedChange(next);
        }}
        disabled={disabled}
      >
        {items.length === 0 ? (
          <option disabled value="">
            {t("noResults")}
          </option>
        ) : (
          items.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
