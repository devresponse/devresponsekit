import { useCallback, useRef, useState } from "react";
import { diffPermissions } from "@/lib/admin/roles.client";

/**
 * F-38: the ONE save path both dual-list editors go through (a role's
 * permissions, a group's roles).
 *
 * The admin API models a dual-list assignment as two independent writes on one
 * collection, a POST `{ [bodyKey]: toAdd }` and a DELETE
 * `{ [bodyKey]: toRemove }`. Each write is atomic; the pair is not (a single
 * atomic `PATCH { add, remove }` is a documented follow-up, see
 * docs/admin-manager.md §8.4), so a save can land half-way. Each editor used
 * to show a generic error when the DELETE failed after the POST had landed,
 * and keep its old baseline. The admin assumed nothing was saved and moved the
 * keys back; the local lists matched the stale baseline again, Save went
 * quiet, and the grant the POST had committed stayed live and invisible until
 * a reload.
 *
 * Three rules close that here, once, for both editors:
 *   1. Additions go FIRST, then removals. The actor's authority is recomputed
 *      on every request from their direct AND group-conferred roles
 *      (`getUserAccessContext`), so a committed write changes what the next
 *      one is judged against. An addition can only widen that authority; a
 *      removal can take away the very permission the next write needs (the
 *      route guard, `admin.groups.assign` / `admin.roles.update`, or the
 *      AUTHZ-3 held set) when the actor's own authority flows through the
 *      role or group being edited. Removals-first would then commit the
 *      removal, have the POST refused, and leave every holder without the
 *      authority, which the actor cannot restore (AUTHZ-3 forbids conferring
 *      what you lack). Additions-first makes such a swap succeed, and its
 *      only partial outcome, "added, not removed" (the DELETE refused by
 *      REVOKE-1 or REVOKE-2), is a grant AUTHZ-3 already let this actor make
 *      on its own; the editor shows it, and the actor may remove it again.
 *      A refused POST stops the save before the DELETE is sent.
 *   2. The server's set is ALWAYS re-read after the writes, success or not,
 *      and the editor resets both its baseline and its lists to it. A failed
 *      response is not proof that nothing committed (a 500 raised after the
 *      insert still leaves the row), so only a fresh GET is trusted. This is
 *      what keeps a committed grant from hiding behind a stale baseline.
 *   3. The failure is classified, so the editor names the guard that refused
 *      the change instead of one generic line. A 403 is read as the AUTHZ-3 /
 *      REVOKE-1 refusal: the route guard answers with the same `forbidden`
 *      code, but under rule 1 a save cannot take that permission away from
 *      the actor between its own writes, so a route-guard 403 means it was
 *      lost elsewhere (another admin's edit) while the editor was open.
 */
export interface DualListEndpoint {
  /** The collection: GET lists the assigned ids; POST / DELETE take `{ [bodyKey]: ids }`. */
  url: string;
  bodyKey: string;
  /** Extracts the assigned ids from the GET response body. */
  readAssigned(body: unknown): ReadonlyArray<string>;
}

/**
 * Why a save stopped: the actor may not confer or remove an item (403), the
 * removal would strip the last platform superadmin (409 `last_superadmin`), or
 * anything else.
 */
export type DualListSaveError = "forbidden" | "lastSuperadmin" | "failed";

export interface DualListSaveResult {
  /** `null` when every write succeeded. */
  error: DualListSaveError | null;
  /**
   * The set the editor must adopt as BOTH its baseline and its lists: the
   * server's re-read set, or, when every write succeeded but the re-read did
   * not, the set that was saved. `null` when a write failed and the re-read
   * failed too, so what the server holds is unknown.
   */
  synced: string[] | null;
}

async function classifyFailure(res: Response): Promise<DualListSaveError> {
  if (res.status === 403) return "forbidden";
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "last_superadmin") return "lastSuperadmin";
  }
  return "failed";
}

async function readServerSet(endpoint: DualListEndpoint): Promise<string[] | null> {
  try {
    const res = await fetch(endpoint.url, { credentials: "same-origin" });
    if (!res.ok) return null;
    return [...endpoint.readAssigned(await res.json())].sort();
  } catch {
    return null;
  }
}

/**
 * Saves the difference between `baseline` (what the editor last read from the
 * server) and `next` (its lists) through `endpoint`: POST, then DELETE, then a
 * re-read of the server's set (see the module comment for why that order).
 */
export async function saveDualListDiff(
  endpoint: DualListEndpoint,
  baseline: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): Promise<DualListSaveResult> {
  const { toAdd, toRemove } = diffPermissions(baseline, next);
  const writes = [
    ["POST", toAdd],
    ["DELETE", toRemove],
  ] as const;
  let error: DualListSaveError | null = null;
  try {
    for (const [method, ids] of writes) {
      if (ids.length === 0) continue;
      const res = await fetch(endpoint.url, {
        method,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [endpoint.bodyKey]: ids }),
      });
      if (!res.ok) {
        // Stop at the first refusal: after a failed POST the DELETE is never
        // sent, so a swap the actor may not complete removes nothing.
        error = await classifyFailure(res);
        break;
      }
    }
  } catch {
    error = "failed";
  }
  const serverSet = await readServerSet(endpoint);
  return { error, synced: serverSet ?? (error === null ? [...next].sort() : null) };
}

/**
 * Wraps {@link saveDualListDiff} for an editor: `saving` disables its controls
 * while a save is in flight, and `stale` locks them for good once a save
 * failed AND the re-read failed, because an editor that cannot say what the
 * server holds must not let the admin keep editing against a guessed baseline.
 * `save` resolves `null` for a second call made while one is in flight.
 */
export function useDualListSave(endpoint: DualListEndpoint) {
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  // A ref as well as the state: two clicks delivered before React re-renders
  // the disabled button would both still read `saving === false`.
  const inFlight = useRef(false);

  const save = useCallback(
    async (
      baseline: ReadonlyArray<string>,
      next: ReadonlyArray<string>,
    ): Promise<DualListSaveResult | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setSaving(true);
      try {
        const result = await saveDualListDiff(endpoint, baseline, next);
        if (result.synced === null) setStale(true);
        return result;
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    },
    [endpoint],
  );

  return { saving, stale, save };
}
