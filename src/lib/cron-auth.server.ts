import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Bearer check shared by every `/api/internal/*` scheduler entrypoint
 * (`outbox-drain`, `mcp-registration-reap`, …). One implementation so the
 * security contract cannot drift between routes (review #51 added the second
 * cron route):
 *
 *   - `expected` is the validated `CRON_SECRET` (`src/lib/env.ts`: optional,
 *     ≥32 chars when set, empty = unset — review #92). Pass it from
 *     `getServerEnv()` at request time so a weak value fails at boot instead
 *     of quietly enabling the endpoint.
 *   - FAILS CLOSED: with no secret configured nothing is ever authorized, so a
 *     deployment that forgets the secret never exposes an unauthenticated
 *     trigger (Vercel Cron would otherwise call the route with no header).
 *   - Constant-time comparison, length-guarded first: `timingSafeEqual`
 *     throws on a length mismatch (which would itself leak the length).
 */
export function isCronAuthorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const presented = Buffer.from(header.slice(prefix.length));
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}
