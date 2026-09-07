/**
 * The pure ban predicate shared by every path that has to decide whether a
 * Better Auth user is *currently* banned (review #126).
 *
 * Why it is its own module: three call sites need the same answer but reach
 * the user row three different ways — the machine-API resolver loads it via
 * `auth.$context` (`api-auth/ban-status.server.ts`), the SSO session plugin
 * already holds it from `internalAdapter.findUserById`, and tests hand in a
 * literal. Duplicating the expiry arithmetic is exactly how the two paths
 * drifted: the plugin rejected on any truthy `banned`, while sign-in and the
 * machine API honour an elapsed `banExpires`. Same rule, one implementation,
 * no `server-only` and no import of the heavy auth instance — so the plugin
 * that *builds* that instance can use it without a cycle.
 *
 * Semantics (Better Auth's own sign-in behaviour):
 *   - falsy `banned`            → not banned.
 *   - `banned` + no `banExpires`→ banned indefinitely.
 *   - `banned` + future expiry  → banned.
 *   - `banned` + elapsed expiry → NOT banned (the temporary ban lapsed; the
 *     admin plugin clears the stale flag on the next sign-in).
 *   - `banned` + unparseable expiry → banned (fail closed): a corrupt value
 *     must never be read as "the ban is over".
 */
export interface BannableUser {
  banned?: boolean | null;
  banExpires?: Date | string | number | null;
}

/**
 * True when `user` is banned right now. `nowMs` is injectable so tests can
 * pin the boundary without faking the global clock; production never passes it.
 */
export function isBanActive(user: BannableUser, nowMs: number = Date.now()): boolean {
  if (!user.banned) return false;

  const banExpires = user.banExpires;
  if (banExpires === null || banExpires === undefined) return true;

  const expiresAt = banExpires instanceof Date ? banExpires : new Date(banExpires);
  const expiresMs = expiresAt.getTime();
  // A malformed/unparseable expiry is treated as an indefinite ban (fail closed).
  if (Number.isNaN(expiresMs)) return true;

  return expiresMs > nowMs;
}
