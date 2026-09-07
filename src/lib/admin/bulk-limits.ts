/**
 * Shared limits for the administrator bulk-action endpoint.
 *
 * Free of `server-only` and of any runtime import so the API route's Zod
 * schema AND the client grid consume the SAME number (review #34): the
 * grid used to carry a comment claiming it mirrored the server cap while
 * checking nothing, so a 501-row selection was sent, rejected with a 400,
 * and reported to the operator as a generic "Bulk action failed." Same
 * pattern as `src/lib/account/preferences.ts`.
 */

/**
 * Maximum number of explicit ids one `POST /api/administrator/users/bulk`
 * request may carry. Also the cap the server applies when expanding
 * `ids: "*"` ("select all matching") into concrete rows.
 */
export const MAX_BULK_IDS = 500;
