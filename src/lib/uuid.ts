/**
 * The app's one UUID shape: RFC 4122 hex-and-dash form, any version, either
 * case. Checking an id against it before a query keeps a malformed one away
 * from a `uuid` column, where Postgres raises 22P02 (an opaque 500), and
 * keeps a forged `x-request-id` out of the logs.
 *
 * The single source of truth (F-133). The route handlers, the shared form
 * schemas in `lib/validation/*`, the request-id check and several server
 * helpers each used to carry their own copy of this pattern. Pure (no
 * `server-only`, no db) so client bundles and `proxy.ts` can import it;
 * `lib/admin/user-target.server.ts` re-exports `isUuid` for the routes that
 * import it from there.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
