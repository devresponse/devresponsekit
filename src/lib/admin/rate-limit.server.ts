import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { adminErrorResponse } from "@/lib/admin/errors.server";

/**
 * In-memory token-bucket rate limiter for Administrator mutation
 * endpoints (docs/admin-manager.md §19 Phase 7, §20.1 #16).
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
 *     buckets. That is acceptable for v1; once a Redis backend lands
 *     this contract continues to hold.
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
 * Convenience for route handlers: enforces a rate limit and returns
 * either `null` (allow — keep going) or a ready-to-return
 * `NextResponse` (deny). Adds the `Retry-After` header on deny.
 */
export function enforceRateLimit(
  scope: string,
  actorId: string,
  options: RateLimitOptions = DEFAULT_ADMIN_MUTATION_LIMIT,
  nowMs?: number,
  request?: { headers: Headers },
  requestId?: string,
): NextResponse | null {
  const result = consumeToken(rateLimitKey(scope, actorId), options, nowMs);
  if (result.ok) return null;
  return adminErrorResponse("rate_limited", 429, request, {
    requestId,
    extra: { retryAfter: result.retryAfterSeconds },
    headers: { "Retry-After": String(result.retryAfterSeconds) },
  });
}

/**
 * Convenience: derive a stable actor identifier for the limiter when
 * a `requireAdminPermission` grant isn't yet available — falls back to
 * the request's first `x-forwarded-for` IP, then to a constant. Only
 * used by callers that need to throttle pre-auth (e.g. open list
 * endpoints); admin mutations should always rate-limit by actor id.
 */
export function actorIdFromRequest(request: NextRequest | { headers: Headers }): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip && ip.length > 0 ? `ip:${ip}` : "anon";
}
