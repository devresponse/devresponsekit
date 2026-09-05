import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { clientIpKey } from "@/lib/client-ip";
import { rateLimitDenialsTotal } from "@/lib/observability/metrics.server";

/**
 * In-memory token-bucket rate limiter for Administrator mutation
 * endpoints.
 *
 * Why an in-memory bucket?
 *   - The plan explicitly calls for an in-memory token bucket as the v1
 *     implementation, with a Redis adapter left as future work. We keep
 *     the surface area pluggable (a single `getStore()` accessor) so a
 *     drop-in replacement can swap the storage layer without touching
 *     call-sites.
 *   - Mutation endpoints (POST / PATCH / DELETE under
 *     `/api/administrator/*`) are the only consumers; read endpoints
 *     are served unbounded because a single admin opening multiple
 *     grid pages must not be throttled.
 *
 * Threat / contract:
 *   - The limiter MUST NOT be the only authorization check — it is a
 *     UX / abuse guard layered on top of `requireAdminPermission`.
 *   - Keys MUST include the actor identifier so one noisy admin cannot
 *     starve another. Callers compose keys via {@link rateLimitKey}.
 *   - The limiter is a soft floor: a process restart resets all
 *     buckets, and the budget is NOT shared across processes. The
 *     supported 1.0 deployment topology is therefore a SINGLE application
 *     instance (see docs/deployment.md §5 "Operations & gotchas" —
 *     "Single application instance (1.0)");
 *     multi-instance is best-effort until a shared backend lands post-1.0.
 *   - Deny responses include a `Retry-After` header (seconds) and a
 *     standard error envelope `{ error: "rate_limited", retryAfter }`.
 */
export interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
  capacity: number;
  refillPerSec: number;
}

export interface RateLimitOptions {
  /** Maximum tokens the bucket can hold (the burst budget). */
  capacity: number;
  /** Tokens added per second. Steady-state requests/second cap. */
  refillPerSec: number;
}

/**
 * Result of a rate-limit check. `ok: true` means the caller may
 * proceed; `ok: false` carries the integer seconds until the next
 * retry.
 */
export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Module-scoped Map serving as the in-memory store. Exported via the
 * accessor below for tests; production code only sees
 * {@link consumeToken}.
 */
const buckets = new Map<string, TokenBucket>();

/**
 * Eviction guard: once the store grows past this size, stale buckets
 * (idle long enough to be fully refilled) are swept on the next
 * consume. Keeps the map bounded by the set of recently active actors
 * instead of growing one entry per actor x scope forever.
 */
const EVICTION_THRESHOLD = 1_000;
const STALE_AFTER_MS = 10 * 60 * 1000;

function evictStaleBuckets(nowMs: number): void {
  if (buckets.size <= EVICTION_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.lastRefillMs > STALE_AFTER_MS) {
      buckets.delete(key);
    }
  }
}

/**
 * Test-only: fully reset the in-memory store. Intentionally not part
 * of the public contract — production callers must never need to wipe
 * the limiter mid-process.
 */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}

/**
 * Refills `bucket` based on wall-clock time elapsed since the last
 * refill, then attempts to consume one token. Returns the structured
 * result; the caller is responsible for translating a deny into an
 * HTTP response.
 *
 * The refill is computed against a configurable `now` so tests can
 * advance time deterministically without faking the global Date.
 */
export function consumeToken(
  key: string,
  options: RateLimitOptions,
  nowMs: number = Date.now(),
): RateLimitResult {
  evictStaleBuckets(nowMs);
  const existing = buckets.get(key);
  const bucket: TokenBucket = existing ?? {
    tokens: options.capacity,
    lastRefillMs: nowMs,
    capacity: options.capacity,
    refillPerSec: options.refillPerSec,
  };

  // Allow callers to lower / raise the limit between requests
  // (e.g. different endpoints sharing one key). Re-set the per-bucket
  // capacity / refill on every call so the most recent caller wins.
  bucket.capacity = options.capacity;
  bucket.refillPerSec = options.refillPerSec;

  const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
  const refilled = Math.min(bucket.capacity, bucket.tokens + elapsedSec * bucket.refillPerSec);
  bucket.tokens = refilled;
  bucket.lastRefillMs = nowMs;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return { ok: true };
  }

  buckets.set(key, bucket);
  // Time (seconds) until one full token is available.
  const tokensNeeded = 1 - bucket.tokens;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(tokensNeeded / Math.max(bucket.refillPerSec, 1e-9)),
  );
  return { ok: false, retryAfterSeconds };
}

/**
 * Composes a rate-limit key. Always namespace by `scope` so different
 * endpoints do not collide in the shared map.
 */
export function rateLimitKey(scope: string, actorId: string): string {
  return `${scope}:${actorId}`;
}

/**
 * Default budget for per-actor mutations: a 30-token burst with a 1
 * token/sec steady refill. Picked so a normal admin clicking through
 * the UI is unaffected, while a script firing hundreds of mutations
 * per minute is throttled.
 */
export const DEFAULT_ADMIN_MUTATION_LIMIT: RateLimitOptions = {
  capacity: 30,
  refillPerSec: 1,
};

/**
 * Default budget for bulk endpoints. Tighter than the per-mutation
 * limit because a single bulk request can already touch up to 500
 * rows.
 */
export const DEFAULT_ADMIN_BULK_LIMIT: RateLimitOptions = {
  capacity: 6,
  refillPerSec: 0.2, // ≈ 1 / 5s
};

/**
 * Default budget for CSV export. Exports are heavy (up to 100k rows)
 * so we keep a low burst and a slow refill.
 */
export const DEFAULT_ADMIN_EXPORT_LIMIT: RateLimitOptions = {
  capacity: 3,
  refillPerSec: 0.05, // ≈ 1 / 20s
};

/**
 * SSO handoff budgets (review #16). Both routes were previously unthrottled,
 * and every failed call writes an append-only `app_audit_events` row.
 *
 * `/api/sso/launch` is keyed per PRINCIPAL — the session user id once a
 * session resolves, the trusted client IP before that — so one noisy user
 * cannot starve the rest of a NAT. A real user launches one handoff per app
 * tile click, so the mutation tier (30 burst, 1/s) is generous.
 */
export const DEFAULT_SSO_LAUNCH_LIMIT: RateLimitOptions = {
  capacity: 30,
  refillPerSec: 1,
};

/**
 * `/api/sso/consume` has no principal until the token verifies, so it is
 * keyed per trusted client IP. A legitimate handoff is one GET + one POST;
 * many users may sit behind one egress IP, so the burst matches the
 * mutation tier rather than the tighter bulk/export tiers.
 */
export const DEFAULT_SSO_CONSUME_LIMIT: RateLimitOptions = {
  capacity: 30,
  refillPerSec: 1,
};

/**
 * Budget for the DENIAL AUDIT, not for traffic. A sustained flood of 429s must
 * not amplify into unbounded `app_audit_events` rows, so each denied actor is
 * audited at most ≈once per minute per scope — enough to know "actor X tripped
 * the limit on scope Y" for forensics, without write-amplifying the attack.
 */
const DENIAL_AUDIT_LIMIT: RateLimitOptions = {
  capacity: 1,
  refillPerSec: 1 / 60,
};

/**
 * Convenience for route handlers: enforces a rate limit and returns
 * either `null` (allow — keep going) or a ready-to-return
 * `NextResponse` (deny). Adds the `Retry-After` header on deny.
 *
 * Signature: `(scope, actorId, options?, request?, requestId?, nowMs?)`.
 * Passing `request` + `requestId` makes the 429 correlate with the
 * request's `x-request-id` / audit rows (the same correlation id the
 * caller's `guard` carries); `nowMs` is test-only and stays last so
 * production callers never need to pass it.
 */
export function enforceRateLimit(
  scope: string,
  actorId: string,
  options: RateLimitOptions = DEFAULT_ADMIN_MUTATION_LIMIT,
  request?: { headers: Headers },
  requestId?: string,
  nowMs?: number,
): NextResponse | null {
  const result = consumeToken(rateLimitKey(scope, actorId), options, nowMs);
  if (result.ok) return null;

  // Count EVERY denial (cheap in-memory counter, no flood concern — unlike the
  // sampled audit below) for the Prometheus `/api/metrics` scrape (#52).
  rateLimitDenialsTotal.inc({ scope });

  // Flood-safe denial audit (P3-9): record that an actor tripped the limit, but
  // gate the write through its OWN very-low-rate bucket (DENIAL_AUDIT_LIMIT) so
  // a sustained 429 flood can't amplify into unbounded audit rows. `auditEvent`
  // is lazy-imported (keeps `audit.server` → `db` out of this module's static
  // graph — the edge-adjacent CSP sink imports this file) and fire-and-forget
  // so it never blocks or fails the 429.
  if (
    consumeToken(rateLimitKey("ratelimit.audit", `${scope}:${actorId}`), DENIAL_AUDIT_LIMIT, nowMs)
      .ok
  ) {
    const isUserId = !actorId.startsWith("ip:") && actorId !== "anon";
    void import("@/lib/audit.server")
      .then(({ auditEvent }) =>
        auditEvent({
          eventType: "administrator.rate_limited",
          outcome: "denied",
          actorBetterAuthUserId: isUserId ? actorId : null,
          request,
          requestId,
          reason: scope,
          metadata: { scope, actor: actorId, retryAfterSeconds: result.retryAfterSeconds },
        }),
      )
      .catch(() => {
        /* best-effort: a denial audit must never break the 429 path */
      });
  }

  return adminErrorResponse("rate_limited", 429, request, {
    requestId,
    extra: { retryAfter: result.retryAfterSeconds },
    headers: { "Retry-After": String(result.retryAfterSeconds) },
  });
}

/**
 * Convenience: derive a stable actor identifier for the limiter when
 * a `requireAdminPermission` grant isn't yet available — falls back to
 * the trusted client IP (P2-4: a proxy hop, not the spoofable leftmost
 * `x-forwarded-for`), then to a constant. Only used by callers that need
 * to throttle pre-auth (e.g. open list endpoints); admin mutations should
 * always rate-limit by actor id.
 */
export function actorIdFromRequest(request: NextRequest | { headers: Headers }): string {
  return clientIpKey(request.headers);
}
