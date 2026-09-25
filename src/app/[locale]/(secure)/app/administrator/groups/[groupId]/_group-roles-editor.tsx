"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { fetchAllPages } from "@/lib/admin/admin-list.client";
import { ListLimitNotice } from "../../_components/list-limit-notice";

/**
 * Dual-list ROLES editor for a group (ADR-0002).
 *
 * Left column = roles available in the org (the org's role catalog minus the
 * ones already bundled). Right column = roles the group currently confers.
 * `Save` diffs against the server's known set and goes through the shared
 * dual-list save (`useDualListSave`, F-38): one POST `{ roleIds: toAdd }`,
 * THEN one DELETE `{ roleIds: toRemove }` against
 * `/api/administrator/groups/[id]/roles` (additions first, so swapping the
 * role that confers the admin's own authority cannot strand the group empty),
 * then a re-read of the group's roles that resets both the baseline and the
 * lists, after a failure too. The server rejects a foreign/global role (404)
 * and, in either direction, a role conferring a permission a non-superadmin
 * does not hold (403, AUTHZ-3 / REVOKE-1).
 *
 * F-41: the org's role catalog is read in full (`fetchAllPages`); it was one
 * `pageSize=200` request, so an org with more roles could not bundle the rest,
 * and nothing said so. A catalog the reader could not finish shows "Showing N
 * of M". The group's assigned roles are merged into the catalog, so one the
 * catalog does not hold, moved out of Assigned, stays in Available (it used
 * to vanish from both columns).
 */
interface RoleOption {
  id: string;
  key: string;
  name: string;
  organization_id: string | null;
  organization_name: string | null;
}

/**
 * Formats a role's display label as `key — Organization` so roles that share a
 * key stay distinguishable. The catalog is scoped to the group's org, so in
 * practice every option carries the same org — the label keeps it explicit
 * rather than showing a bare `admin` that looks like a duplicate of another org's.
 */
function formatRoleLabel(key: string, organizationName: string | null): string {
  return organizationName ? `${key} — ${organizationName}` : key;
}

export function GroupRolesEditor({ groupId, canAssign }: { groupId: string; canAssign: boolean }) {
  const t = useTranslations("administrator.groups.rolesEditor");
  const tErr = useTranslations("administrator.errors");

  const [catalog, setCatalog] = useState<RoleOption[] | null>(null);
  // Catalog rows read vs. the server's count of them (F-41), for the notice.
  const [catalogRead, setCatalogRead] = useState({ shown: 0, total: 0 });
  const [assigned, setAssigned] = useState<string[]>([]);
  const [serverAssigned, setServerAssigned] = useState<string[]>([]);
  const [availableSelected, setAvailableSelected] = useState<string[]>([]);
  const [assignedSelected, setAssignedSelected] = useState<string[]>([]);
  const [availableQ, setAvailableQ] = useState("");
  const [assignedQ, setAssignedQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // The group's organization id, fetched from the API (not passed as a prop) so
  // the editor is self-contained and the scope can never go stale.
  const [orgId, setOrgId] = useState<string | null>(null);

  const endpoint = useMemo<DualListEndpoint>(
    () => ({
      url: `/api/administrator/groups/${groupId}/roles`,
      bodyKey: "roleIds",
      readAssigned: (body) => (body as { roles: Array<{ id: string }> }).roles.map((r) => r.id),
    }),
    [groupId],
  );
  const { saving, stale, save } = useDualListSave(endpoint);
  // Nothing may move while a save is in flight (its re-read would overwrite
  // the move) or once the server's set is unknown.
  const locked = !canAssign || saving || stale;

  // Load the group's org + currently-assigned roles, then the org-scoped role
  // catalog. The org id comes from the group-detail endpoint (a live request),
  // NOT a prop, so the scope is always correct regardless of how the editor is
  // mounted.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [detailRes, assignedRes] = await Promise.all([
          fetch(`/api/administrator/groups/${groupId}`, { credentials: "same-origin" }),
          fetch(`/api/administrator/groups/${groupId}/roles`, { credentials: "same-origin" }),
        ]);
        if (!detailRes.ok || !assignedRes.ok) {
          if (!cancelled) setError(tErr("generic"));
          return;
        }
        const detailBody = (await detailRes.json()) as { group: { organization_id: string } };
        const assignedBody = (await assignedRes.json()) as {
          roles: Array<{ id: string; key?: string; name?: string }>;
        };
        const groupOrgId = detailBody.group.organization_id;

        // Scope the catalog to the group's OWN org: the assignment endpoint
        // rejects foreign-org / global roles (404), so only same-org roles are
        // assignable. Scoping the list means it never shows a role that would
        // fail on save, and drops the cross-org "duplicate" noise. Server-side
        // scoping also keeps other orgs' roles from filling the pages read.
        const all = await fetchAllPages<RoleOption>(
          `/api/administrator/roles?filter[organization]=${groupOrgId}`,
        );
        if (cancelled) return;
        // An assigned role the catalog does not hold (F-41) joins it, so it
        // can be moved out of Assigned and back. It is the group's own org's
        // (the server refuses any other), which the `orgId` guard below needs.
        const inCatalog = new Set(all.items.map((r) => r.id));
        const orgName = all.items[0]?.organization_name ?? null;
        const outside: RoleOption[] = assignedBody.roles
          .filter((r) => !inCatalog.has(r.id))
          .map((r) => ({
            id: r.id,
            key: r.key ?? r.id,
            name: r.name ?? r.key ?? r.id,
            organization_id: groupOrgId,
            organization_name: orgName,
          }));
        setOrgId(groupOrgId);
        setCatalog([...all.items, ...outside]);
        setCatalogRead({ shown: all.items.length, total: all.total });
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

  // Org name per role id, so the assigned column can carry the same
  // `key — Organization` label as the available column.
  const orgNameById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of catalog ?? []) m.set(r.id, r.organization_name);
    return m;
  }, [catalog]);

  const assignedSet = useMemo(() => new Set(assigned), [assigned]);

  const availableFiltered = useMemo(() => {
    if (!catalog) return [];
    const q = availableQ.trim().toLowerCase();
    return (
      catalog
        // Only the group's own org is assignable. The fetch is server-scoped via
        // `filter[organization]` (parseListQuery silently drops any other param
        // shape); this client-side guard is defense-in-depth so a foreign-org
        // role can never slip into the list (and then fail on save).
        .filter((r) => r.organization_id === orgId)
        .filter((r) => !assignedSet.has(r.id))
        .filter((r) => (q ? r.key.toLowerCase().includes(q) : true))
    );
  }, [catalog, assignedSet, availableQ, orgId]);

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
    const result = await save(serverAssigned, assigned);
    if (!result) return;
    if (result.synced) {
      setAssigned(result.synced);
      setServerAssigned(result.synced);
      setAvailableSelected([]);
      setAssignedSelected([]);
    }
    if (result.error === null) {
      setInfo(t("saved"));
      return;
    }
    // The group routes never answer 409 `last_superadmin` (REVOKE-2 counts
    // direct assignments only, docs/admin-manager.md §8.6), but the shared
    // classification is total, so the message is mapped anyway.
    const messages: Record<DualListSaveError, string> = {
      forbidden: t("forbidden"),
      lastSuperadmin: tErr("lastSuperadmin"),
      failed: t("errorToast"),
    };
    setError(messages[result.error]);
  }, [save, serverAssigned, assigned, t, tErr]);

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
        <Column
          titleKey="available"
          searchKey="searchAvailable"
          options={availableFiltered.map((r) => ({
            id: r.id,
            label: formatRoleLabel(r.key, r.organization_name),
          }))}
          selected={availableSelected}
          onSelectedChange={setAvailableSelected}
          q={availableQ}
          onQChange={setAvailableQ}
          disabled={locked}
        />
        <Column
          titleKey="assigned"
          searchKey="searchAssigned"
          options={assignedFiltered.map((id) => ({
            id,
            label: formatRoleLabel(keyById.get(id) ?? id, orgNameById.get(id) ?? null),
          }))}
          selected={assignedSelected}
          onSelectedChange={setAssignedSelected}
          q={assignedQ}
          onQChange={setAssignedQ}
          disabled={locked}
        />
      </div>
      <ListLimitNotice shown={catalogRead.shown} total={catalogRead.total} kind="catalog" />

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
