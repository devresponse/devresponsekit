/**
 * Client-safe re-export / re-implementation of helpers from
 * `roles.server.ts` that are pure (no DB / no `server-only` import) so
 * they can run in the browser bundle for the dual-list editor.
 *
 * Keeping `roles.server.ts` flagged `server-only` is the correct
 * default — leaking that module to the client would force the entire
 * Kysely + pg pool to be tree-walked. Instead we mirror the small
 * pure helpers here. Tests pin the two implementations against the
 * same expected behaviour so they cannot drift.
 */

/**
 * Pure diff helper: returns `{ toAdd, toRemove }` between two unordered
 * collections of permission keys. Mirrors `roles.server.ts`.
 */
export function diffPermissions(
  current: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): { toAdd: string[]; toRemove: string[] } {
  const cur = new Set(current);
  const nxt = new Set(next);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const k of nxt) if (!cur.has(k)) toAdd.push(k);
  for (const k of cur) if (!nxt.has(k)) toRemove.push(k);
  toAdd.sort();
  toRemove.sort();
  return { toAdd, toRemove };
}
