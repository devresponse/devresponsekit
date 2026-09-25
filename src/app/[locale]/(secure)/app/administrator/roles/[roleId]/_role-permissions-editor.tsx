"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDualListSave,
  type DualListEndpoint,
  type DualListSaveError,
} from "@/lib/admin/dual-list-save.client";
import { diffPermissions } from "@/lib/admin/roles.client";

/**
 * Dual-list permissions editor (docs/admin-manager.md §8.4).
 *
 * Left column = available permissions (full catalog minus assigned).
 * Right column = currently assigned. Multi-select on either side; the
 * `Add` / `Remove` buttons move the selected keys between columns.
 *
 * `Save` diffs against the server's known set and goes through the shared
 * dual-list save (`useDualListSave`, F-38): one POST `{ ids: toAdd }`,
 * THEN one DELETE `{ ids: toRemove }` against
 * `/api/administrator/roles/[id]/permissions` (additions first, so a swap on a
 * role the admin's own authority comes through cannot strand it half-done),
 * then a re-read of the role's set that resets both the baseline and the
 * lists — after a failure too, so a half-applied save is shown as it landed
 * and a committed grant can never hide behind a stale baseline.
 *
 * F-39: the editor is seeded from the page's `initialAssigned`, and the
 * Permissions tab panel unmounts when another tab is opened. After a save,
 * switching to Members and back re-seeded it from the pre-save set, so a
 * removed key showed as Assigned again and an added one as Available. Every
 * save therefore ends with `router.refresh()`, which makes the page's set the
 * saved one, and the editor adopts a changed `initialAssigned` whenever it has
 * no unsaved moves and no save in flight (the refresh may land after the
 * remount). Moves in progress are never overwritten; the next save re-reads
 * the server's set anyway (F-38).
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
  const router = useRouter();

  const [catalog, setCatalog] = useState<CatalogRow[] | null>(null);
  const [assigned, setAssigned] = useState<string[]>([...initialAssigned].sort());
  const [serverAssigned, setServerAssigned] = useState<string[]>([...initialAssigned].sort());
  // The `initialAssigned` the lists were last seeded from (F-39), by content.
  const initialKey = JSON.stringify([...initialAssigned].sort());
  const [seededFrom, setSeededFrom] = useState(initialKey);

  const [availableSelected, setAvailableSelected] = useState<string[]>([]);
  const [assignedSelected, setAssignedSelected] = useState<string[]>([]);
  const [availableQ, setAvailableQ] = useState("");
  const [assignedQ, setAssignedQ] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const endpoint = useMemo<DualListEndpoint>(
    () => ({
      url: `/api/administrator/roles/${roleId}/permissions`,
      bodyKey: "ids",
      readAssigned: (body) => (body as { permissions: string[] }).permissions,
    }),
    [roleId],
  );
  const { saving, stale, save } = useDualListSave(endpoint);
  // Nothing may move while a save is in flight (its re-read would overwrite
  // the move) or once the server's set is unknown.
  const locked = !canUpdate || saving || stale;

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

  // F-39: follow the page's set once a refresh brings a new one, unless the
  // admin has unsaved moves or a save is in flight (its re-read decides then).
  // State adjusted during render, React's pattern for "reset on prop change"
  // without a remount (which would drop the saved notice).
  if (seededFrom !== initialKey) {
    setSeededFrom(initialKey);
    if (!dirty && !saving) {
      const next = JSON.parse(initialKey) as string[];
      setAssigned(next);
      setServerAssigned(next);
    }
  }

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
    const result = await save(serverAssigned, assigned);
    if (!result) return;
    if (result.synced) {
      setAssigned(result.synced);
      setServerAssigned(result.synced);
      setAvailableSelected([]);
      setAssignedSelected([]);
    }
    // F-39: after ANY save (a failed one may have landed half-way, F-38), so
    // the page's `initialAssigned` is what the server now holds and a tab
    // switch cannot re-seed the editor from the pre-save set.
    router.refresh();
    if (result.error === null) {
      setInfo(t("saved"));
      return;
    }
    const messages: Record<DualListSaveError, string> = {
      forbidden: t("forbidden"),
      lastSuperadmin: tErr("lastSuperadmin"),
      failed: t("errorToast"),
    };
    setError(messages[result.error]);
  }, [save, serverAssigned, assigned, router, t, tErr]);

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
        <div className="text-destructive space-y-1 text-sm" role="alert">
          <p>{error}</p>
          {stale ? <p>{tErr("saveStateUnknown")}</p> : null}
        </div>
      ) : null}
      {info ? (
        <p className="text-success text-sm" role="status">
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
          disabled={locked}
        />
        <DualListColumn
          titleKey="assigned"
          searchKey="searchAssigned"
          items={assignedFiltered}
          selected={assignedSelected}
          onSelectedChange={setAssignedSelected}
          q={assignedQ}
          onQChange={setAssignedQ}
          disabled={locked}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={moveToAssigned}
          disabled={locked || availableSelected.length === 0}
        >
          {t("add")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={moveToAvailable}
          disabled={locked || assignedSelected.length === 0}
        >
          {t("remove")}
        </Button>
        <div className="flex-1" />
        <Button type="button" size="sm" onClick={onSave} disabled={locked || !dirty}>
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
