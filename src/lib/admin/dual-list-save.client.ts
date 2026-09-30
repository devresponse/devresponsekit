import { useCallback, useRef, useState } from "react";
import { diffPermissions } from "@/lib/admin/roles.client";

/**
 * F-38: the ONE save path both dual-list editors go through (a role's
 * permissions, a group's roles).
 *
 * The editors used to save through two writes on one collection, a POST of the
 * additions and then a DELETE of the removals. The pair was not atomic: when
 * the DELETE was refused after the POST had landed, the editor showed a
 * generic error and kept its old baseline, the admin moved the keys back, Save
 * went quiet, and the grant the POST had committed stayed live and invisible
 * until a reload. An interim fix sent additions first and re-read the server
 * after every save.
 *
 * Each collection now takes ONE `PATCH { add, remove }`, which the server
 * applies in one transaction after running every guard on both sets (AUTHZ-3,
 * REVOKE-1, REVOKE-2), judged against the actor's authority as the request
 * found it. A save therefore lands whole or not at all, and swapping the item
 * the actor's own authority comes through for an equivalent one succeeds (the
 * removal cannot take away the authority the addition is judged by). Two rules
 * stay here, once, for both editors:
 *   1. The server's set is ALWAYS re-read after the save, success or not, and
 *      the editor resets both its baseline and its lists to it. A failed
 *      response is not proof that nothing committed (a 500 raised after the
 *      commit still leaves the rows), so only a fresh GET is trusted, and a
 *      committed grant can never hide behind a stale baseline.
 *   2. The failure is classified, so the editor names the guard that refused
 *      the change instead of one generic line. A 403 is read as the AUTHZ-3 /
 *      REVOKE-1 refusal: the route guard answers with the same `forbidden`
 *      code, but one request cannot take that permission away from the actor
 *      part-way, so a route-guard 403 means it was lost elsewhere (another
 *      admin's edit) while the editor was open.
 */
export interface DualListEndpoint {
  /** The collection: GET lists the assigned ids; PATCH takes `{ add, remove }`. */
  url: string;
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
  /** `null` when the save succeeded (or there was nothing to send). */
  error: DualListSaveError | null;
  /**
   * The set the editor must adopt as BOTH its baseline and its lists: the
   * server's re-read set, or, when the save succeeded but the re-read did
   * not, the set that was saved. `null` when the save failed and the re-read
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
 * server) and `next` (its lists) through `endpoint`: one PATCH
 * `{ add, remove }`, then a re-read of the server's set (see the module
 * comment). Nothing is sent when the lists match the baseline.
 */
export async function saveDualListDiff(
  endpoint: DualListEndpoint,
  baseline: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): Promise<DualListSaveResult> {
  const { toAdd, toRemove } = diffPermissions(baseline, next);
  let error: DualListSaveError | null = null;
  if (toAdd.length > 0 || toRemove.length > 0) {
    try {
      const res = await fetch(endpoint.url, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ add: toAdd, remove: toRemove }),
      });
      if (!res.ok) error = await classifyFailure(res);
    } catch {
      error = "failed";
    }
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
