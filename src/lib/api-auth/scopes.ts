/**
 * API credential scope vocabulary and matching (design
 * docs/design-api-keys-and-tokens.md §7).
 *
 * Scopes ARE the existing permission vocabulary — the admin permission
 * catalog (`ADMIN_PERMISSION_CATALOG`, every `admin.*` key) plus a small
 * set of user-level `account.*` scopes for the self-service surface. Reusing the permission keys means a credential's
 * authority is expressed in the same terms `requireAdminPermission`
 * already enforces, so a credential can never invent authority that the
 * permission model doesn't understand.
 *
 * This module is intentionally pure (no IO, no `server-only`) so it can
 * be imported by route handlers, the resolver, seed/tooling scripts, and
 * unit tests alike.
 */
import { ANY_ADMIN_PERMISSION } from "@/lib/admin/permissions";

/**
 * User-level scopes for the Account self-service surface. These are NOT
 * `app_permissions` rows — they gate the strictly self-scoped
 * `/api/account/*` + `/api/v1/me/*` routes, which require only an active
 * membership (not an `admin.*` permission). Any signed-in user may mint a
 * credential carrying these scopes for their own account.
 */
export const ACCOUNT_SCOPES: ReadonlyArray<string> = [
  "account.read",
  "account.profile.write",
  "account.preferences.write",
  "account.apikeys.manage",
];

/**
 * The complete scope catalog a credential may be granted: every admin
 * permission key plus the account scopes. Used for request validation
 * and the published OpenAPI `securitySchemes`.
 */
export const API_SCOPE_CATALOG: ReadonlyArray<string> = [
  ...ANY_ADMIN_PERMISSION,
  ...ACCOUNT_SCOPES,
];

const ACCOUNT_SCOPE_SET = new Set(ACCOUNT_SCOPES);
const CATALOG_SET = new Set(API_SCOPE_CATALOG);

/** True when `scope` is a recognized scope (admin permission or account scope). */
export function isKnownScope(scope: string): boolean {
  return CATALOG_SET.has(scope) || isWildcardScope(scope);
}

/** True when `scope` is an `account.*` self-service scope. */
export function isAccountScope(scope: string): boolean {
  return ACCOUNT_SCOPE_SET.has(scope);
}

/**
 * Wildcard sugar: a granted scope ending in `.*` matches any required
 * key sharing the prefix (e.g. `admin.users.*` ⊇ `admin.users.read`).
 * The stored grant may use a wildcard, but the matcher expands it at
 * check time so authorization stays explicit and auditable.
 */
export function isWildcardScope(scope: string): boolean {
  return scope.endsWith(".*");
}

/** True when a single granted scope authorizes a single required permission. */
export function scopeMatches(granted: string, required: string): boolean {
  if (granted === required) return true;
  if (granted === "*") return true; // full-authority sugar (rarely issued)
  if (isWildcardScope(granted)) {
    const prefix = granted.slice(0, -1); // keep the trailing dot: "admin.users."
    return required.startsWith(prefix);
  }
  return false;
}

/**
 * True when the granted-scope set authorizes the required permission.
 * A `null` grant means "no scope restriction" — used for cookie sessions,
 * which carry the principal's full authority. Bearer credentials always
 * pass an explicit (possibly empty) array.
 */
export function scopesAuthorize(
  grantedScopes: ReadonlyArray<string> | null,
  required: string,
): boolean {
  if (grantedScopes === null) return true;
  return grantedScopes.some((g) => scopeMatches(g, required));
}

/**
 * Normalizes a raw scope input (array or OAuth space-delimited string)
 * into a deduplicated array, dropping empties.
 */
export function normalizeScopes(
  input: string | ReadonlyArray<string> | null | undefined,
): string[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(/\s+/);
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

/**
 * Validates that a credential creator may grant every requested scope.
 *
 * Threat / contract (principle #2 — least privilege by construction):
 *   - `account.*` scopes are always self-grantable (they only ever act on
 *     the creator's own account).
 *   - Every other scope MUST be a permission the creator currently holds,
 *     so a credential can never out-scope the human who minted it.
 *   - Unknown scopes are rejected outright.
 *
 * Returns the list of scopes the creator is NOT allowed to grant (empty
 * when every requested scope is grantable).
 */
export function ungrantableScopes(
  creatorPermissions: ReadonlyArray<string>,
  requestedScopes: ReadonlyArray<string>,
): string[] {
  const held = new Set(creatorPermissions);
  return requestedScopes.filter((scope) => {
    if (!isKnownScope(scope)) return true;
    if (isAccountScope(scope)) return false;
    if (isWildcardScope(scope)) {
      // A wildcard is grantable only if the creator holds at least one
      // matching permission AND every catalog key under the prefix.
      const prefix = scope.slice(0, -1);
      const covered = API_SCOPE_CATALOG.filter((k) => k.startsWith(prefix));
      return covered.length === 0 || !covered.every((k) => held.has(k));
    }
    return !held.has(scope);
  });
}

/**
 * Caller-aware grantability — closes the bearer self-escalation gap.
 *
 * When a credential mints another credential, the new one must NOT exceed
 * the calling credential's own authority:
 *   - Cookie session (`callerGrantedScopes === null`): full user
 *     authority — delegates exactly like {@link ungrantableScopes}
 *     (account scopes self-grantable, admin scopes require the permission).
 *   - Bearer credential: may delegate ONLY scopes it already holds, so a
 *     narrowly-scoped key can never mint a broader one.
 *
 * Returns the requested scopes the caller may NOT grant (empty when all
 * are grantable).
 */
export function ungrantableScopesForCaller(
  callerPermissions: ReadonlyArray<string>,
  callerGrantedScopes: ReadonlyArray<string> | null,
  requestedScopes: ReadonlyArray<string>,
): string[] {
  if (callerGrantedScopes === null) {
    return ungrantableScopes(callerPermissions, requestedScopes);
  }
  return requestedScopes.filter(
    (scope) => !isKnownScope(scope) || !scopesAuthorize(callerGrantedScopes, scope),
  );
}
