import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * The one bearer check for the operator-secret endpoints: every
 * `/api/internal/*` scheduler entrypoint (`outbox-drain`,
 * `mcp-registration-reap`, …) against `CRON_SECRET`, and the Prometheus scrape
 * `/api/metrics` against `METRICS_TOKEN`. One implementation so the security
 * contract cannot drift between routes (review #51 added the second cron
 * route; I-08 found `/api/metrics` carrying a hand-rolled copy, which a
 * hardening here would have silently missed):
 *
 *   - `expected` is the validated secret (`src/lib/env.ts` `operatorSecret`:
 *     optional, ≥32 chars when set, empty = unset — review #92/#222). Pass it
 *     from `getServerEnv()`, whose schema `register()` parses at boot (F-26),
 *     so a weak value stops the server from starting instead of quietly
 *     enabling the endpoint.
 *   - FAILS CLOSED: with no secret configured nothing is ever authorized, so a
 *     deployment that forgets the secret never exposes an unauthenticated
 *     trigger (Vercel Cron would otherwise call the route with no header) or
 *     leaks its metrics.
 *   - Constant-time comparison, length-guarded first: `timingSafeEqual`
 *     throws on a length mismatch (which would itself leak the length).
 */
export function isOperatorBearerAuthorized(
  request: Request,
  expected: string | undefined,
): boolean {
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const presented = Buffer.from(header.slice(prefix.length));
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}
