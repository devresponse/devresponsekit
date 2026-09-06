/**
 * Weak ETag helpers for the `/api/v1` surface (design §8.1 — optimistic
 * concurrency via ETag + If-Match). The entity tag is derived from a
 * row's `updated_at` so a stale client write (`If-Match` not matching the
 * current tag) can be rejected with `412 Precondition Failed`.
 *
 * Pure (no IO) so it is shared by route handlers and unit tests.
 */

/**
 * Builds a weak ETag from a row's `updated_at` timestamp. Accepts the
 * Kysely column value (a `Date` at runtime for `timestamptz`, or a string).
 */
export function userEtag(updatedAt: Date | string): string {
  const iso =
    updatedAt instanceof Date ? updatedAt.toISOString() : new Date(updatedAt).toISOString();
  return `W/"${iso}"`;
}

/**
 * Evaluates an inbound `If-Match` header against the current tag.
 *   - No header → `true` (precondition not requested; last-write-wins).
 *   - `*`        → `true` (matches any existing entity).
 *   - Otherwise  → exact tag match (whitespace-insensitive between values).
 */
export function ifMatchSatisfied(ifMatch: string | null, currentEtag: string): boolean {
  if (!ifMatch) return true;
  const candidates = ifMatch.split(",").map((s) => s.trim());
  if (candidates.includes("*")) return true;
  return candidates.includes(currentEtag);
}

/**
 * True when the caller pinned a CONCRETE version — i.e. `If-Match` is present
 * and is not the `*` wildcard.
 *
 * `ifMatchSatisfied` alone cannot carry optimistic concurrency: it is a
 * check-then-act on a value read earlier in the request (review #44). A route
 * uses this to decide whether to hand the read version down to the mutation so
 * the WHERE clause can do the compare-and-swap. `*` and an absent header both
 * mean "no version pinned" → last-write-wins, unchanged.
 */
export function ifMatchPinsVersion(ifMatch: string | null): boolean {
  if (!ifMatch) return false;
  return !ifMatch
    .split(",")
    .map((s) => s.trim())
    .includes("*");
}
